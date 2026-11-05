# External login confirmation

The examples below show the terms-enabled composition.
When terms are enabled, add `TermsRequiredError` from the entry-linked terms workflow before using these examples.
When terms are disabled, omit its import and catch branch, and replace the terms-marker throw with an explicit error explaining that the server requires terms outside the approved setup.
Do not silently bypass that server requirement or create an unapproved `/terms` route.

## Contents

- [Service contract](#auth-service-additions-when-any-external-provider-is-configured)
- [Cookie state](#state-storage-that-makes-this-work)
- [Service implementation](#auth-service-additions)
- [Page example](#page-component-react)
- [Expiry](#cookie-expiry-handling)

```
Email link / "Sign in with Entra External ID" button
   ↓
POST /Account/Login/ExternalLogin → server redirects to IdP
   ↓
User authenticates at IdP → IdP callback to /signin-{providername}
   ↓
OIDC middleware processes callback (sets __External cookie with claims)
   ↓
Forward to /Account/Login/ExternalLoginCallback
   ↓
ExternalLoginCallback action: new user, no existing contact
   → returns ExternalLoginConfirmation view at the callback URL
   ↓
┌─ Code-Site-Shell-Header script catches /account/login/externallogincallback ─┐
│  → window.location.replace('/external-login-confirmation' + query)            │
└────────────────────────────────────────────────────────────────────────────────┘
   ↓
SPA /external-login-confirmation page mounts
   → calls fetchExternalLoginDetails()
     → GET /Account/Login/ExternalLoginCallback (__External cookie auto-sent)
     → server returns the same rendered HTML
     → SPA parses #Email, #FirstName, #LastName, #Username, #InvitationCode,
       __RequestVerificationToken, and the form's action URL for ReturnUrl
   ↓
SPA renders own form, email pre-filled and editable
   ↓
User clicks "Create my account"
   → confirmExternalLogin() POST /Account/Login/ExternalLoginConfirmation
     (form fields + anti-forgery token, redirect:'manual')
   ↓
   ├── response.type === 'opaqueredirect' → window.location.href = returnUrl
   │     (server sets ApplicationCookie BEFORE returning 302 - user is signed in)
   ├── 200 OK with validation-summary → throw parsed error (e.g., duplicate email
   │     when RequireUniqueEmail is true and user typed an existing email)
   └── 200 OK with TermsAndConditions markers → throw TermsRequiredError →
         SPA navigates to /terms
```

### Auth service additions (when any external provider is configured)

Add these functions to `src/services/authService.ts` using the code below:

- `ExternalLoginCookieExpiredError` class - thrown when the `__External` cookie has expired (5-minute TTL exceeded). The page navigates to `/login` with an expired-session message.
- `fetchExternalLoginDetails()` - fetches `/Account/Login/ExternalLoginCallback`, parses HTML for pre-fill values and anti-forgery token. Throws `ExternalLoginCookieExpiredError` if the form isn't present.
- `confirmExternalLogin(details)` - POSTs to `/Account/Login/ExternalLoginConfirmation` with `redirect:'manual'`. Branches on response type to navigate or throw.

### SPA page

Create `src/pages/ExternalLoginConfirmation.tsx`:

- On mount, calls `fetchExternalLoginDetails()`. Three states: loading, cookie-expired, ready.
- When cookie expired: shows "Sign-in session expired" with a "Back to sign in" link to `/login`.
- When ready: shows the user's full name read-only (from claims), an editable email input (default = email claim), and an "invitation banner" if `invitationCode` is non-empty.
- On submit, calls `confirmExternalLogin(details)`. Handles `TermsRequiredError` → navigate to `/terms`. Handles `ExternalLoginCookieExpiredError` (mid-session expiry) → switch UI to the expired state.
- Server-side validation errors shown inline via `parseServerErrors`.

### Routing

Add `<Route path="/external-login-confirmation" element={<ExternalLoginConfirmation />} />`.

### DevTools artifact

After the POST, the network panel may show the 302 Location target (e.g., the returnUrl path) as an aborted (`net::ERR_ABORTED`) request - same as the RedeemInvitation pattern. Expected behavior from `redirect:'manual'`, not an error.

### Edge cases

- **2FA**: If the user has 2FA enabled, the challenge happens AFTER `SignInAsync` completes (during the 302 redirect). The SPA-ified flow doesn't interfere - the 2FA challenge (`SendCode`/`VerifyCode`) is its own server-rendered flow that cannot be intercepted.
- **`SameSite=Strict`**: If the `__External` cookie is configured with `SameSite=Strict`, the SPA's fetch won't include it and `fetchExternalLoginDetails` throws `ExternalLoginCookieExpiredError` immediately. Default is `Lax` (set via `SameSiteCookieHelper.GetOwinSameSiteFromSiteSettings`) - works fine.
- **Invited user via external login**: Invitation code is captured from the form action URL by `fetchExternalLoginDetails` and re-sent on the POST. The server redeems the invitation as part of contact creation.

## External Login Confirmation Flow for SPA Sites

When a user signs in with an external provider (Entra External ID, OIDC, SAML2, etc.) for the first time and no Dataverse contact exists, the server renders `ExternalLoginConfirmation.aspx` at the OIDC callback URL (`/Account/Login/ExternalLoginCallback`). The user confirms/edits their email and the server creates the contact + signs them in. We SPA-ify this with the same pattern as Reset Password and Redeem Invitation.

### State storage that makes this work

The IdP's claims are stored in the `__External` cookie set by the OIDC middleware:

- `AuthenticationType = DefaultAuthenticationTypes.ExternalCookie` (`__External`)
- `ExpireTimeSpan = TimeSpan.FromMinutes(5)`
- `CookieSecure = CookieSecureOption.Always`
- `AuthenticationMode = AuthenticationMode.Passive` - auto-sent on same-origin requests
- `CookieSameSite` derived from site settings (typically `Lax`)

The SPA's fetch with `credentials: 'same-origin'` includes this cookie automatically, so the server returns the claim-populated form.

### Header template entry

Extend the `Code-Site-Shell-Header` redirect map:

```js
var redirects = {
  '/account/login/resetpassword': '/reset-password',
  '/account/login/redeeminvitation': '/redeem-invitation',
  '/account/login/externallogincallback': '/external-login-confirmation'  // ← add this
};
```

### Auth service additions

#### Types and error class

```typescript
export interface ExternalLoginDetails {
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  invitationCode: string;
  returnUrl: string;
  antiForgeryToken: string;
}

export class ExternalLoginCookieExpiredError extends Error {
  constructor() {
    super('External login session expired. Please sign in again.');
    this.name = 'ExternalLoginCookieExpiredError';
  }
}
```

#### `fetchExternalLoginDetails()` - pre-fetch claim-populated form

```typescript
export async function fetchExternalLoginDetails(): Promise<ExternalLoginDetails> {
  if (isDevelopment) {
    return {
      email: 'invited.user@contoso.com',
      firstName: 'Invited',
      lastName: 'User',
      username: 'invited.user',
      invitationCode: '',
      returnUrl: '/',
      antiForgeryToken: 'dev-token',
    };
  }

  const response = await fetch('/Account/Login/ExternalLoginCallback', {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch external login details (status ${response.status}).`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // ExternalLoginFailure.aspx is returned when the __External cookie has expired.
  // Detect by the absence of the confirmation form.
  if (!doc.querySelector('input[name="Email"]')) {
    throw new ExternalLoginCookieExpiredError();
  }

  const getValue = (selector: string): string =>
    (doc.querySelector(selector) as HTMLInputElement | null)?.value || '';

  const formAction = doc.querySelector('form')?.getAttribute('action') || '';
  const actionParams = new URLSearchParams(formAction.split('?')[1] || '');

  return {
    email: getValue('input[name="Email"]'),
    firstName: getValue('input[name="FirstName"]'),
    lastName: getValue('input[name="LastName"]'),
    username: getValue('input[name="Username"]'),
    invitationCode: getValue('input[name="InvitationCode"]') || actionParams.get('InvitationCode') || '',
    returnUrl: actionParams.get('ReturnUrl') || '/',
    antiForgeryToken: getValue('input[name="__RequestVerificationToken"]'),
  };
}
```

#### `confirmExternalLogin()` - POST with redirect detection

```typescript
export async function confirmExternalLogin(details: ExternalLoginDetails): Promise<void> {
  if (isDevelopment) {
    window.location.href = details.returnUrl || '/';
    return;
  }

  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', details.antiForgeryToken);
  body.set('Email', details.email);
  body.set('FirstName', details.firstName);
  body.set('LastName', details.lastName);
  body.set('Username', details.username);

  // Server reads ReturnUrl and InvitationCode from the form action URL query string.
  const params = new URLSearchParams();
  if (details.returnUrl) params.set('ReturnUrl', details.returnUrl);
  if (details.invitationCode) params.set('InvitationCode', details.invitationCode);
  const qs = params.toString();
  const postUrl = `/Account/Login/ExternalLoginConfirmation${qs ? `?${qs}` : ''}`;

  const response = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'manual',
  });

  // Server sets ApplicationCookie BEFORE returning the 302 - user is signed in.
  if (response.type === 'opaqueredirect') {
    window.location.href = details.returnUrl || '/';
    return;
  }

  if (response.ok) {
    const html = await response.text();
    const errors = parseServerErrors(html);
    if (errors.length > 0) throw new Error(errors.join(' '));

    // Server may render TermsAndConditions instead of redirecting to it.
    if (html.includes('TermsAndConditions') || html.includes('IsTermsAndConditionsAccepted')) {
      throw new TermsRequiredError();
    }

    throw new Error('Unable to complete external login. Please try again.');
  }

  throw new Error(`Failed to confirm external login (status ${response.status}).`);
}
```

### Page component (React)

```tsx
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  fetchExternalLoginDetails,
  confirmExternalLogin,
  ExternalLoginCookieExpiredError,
  TermsRequiredError,
  type ExternalLoginDetails,
} from '../services/authService'

export default function ExternalLoginConfirmation() {
  const navigate = useNavigate()
  const [details, setDetails] = useState<ExternalLoginDetails | null>(null)
  const [email, setEmail] = useState('')
  const [cookieExpired, setCookieExpired] = useState(false)
  // ... isLoading, isSubmitting, serverError state, validation, etc.

  useEffect(() => {
    fetchExternalLoginDetails()
      .then(d => { setDetails(d); setEmail(d.email) })
      .catch(err => {
        if (err instanceof ExternalLoginCookieExpiredError) setCookieExpired(true)
        // else show serverError
      })
  }, [])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!details) return
    confirmExternalLogin({ ...details, email }).catch(err => {
      if (err instanceof TermsRequiredError) return navigate('/terms')
      if (err instanceof ExternalLoginCookieExpiredError) return setCookieExpired(true)
      // else show serverError
    })
  }

  if (cookieExpired) return <ExpiredCard />
  if (!details) return <LoadingCard />

  return (
    <form onSubmit={handleSubmit}>
      <h1>Almost done!</h1>
      {details.invitationCode && <Banner>Redeeming invitation {details.invitationCode}</Banner>}
      <ReadOnlyRow label="Name" value={`${details.firstName} ${details.lastName}`} />
      <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
      <button type="submit">Create my account</button>
    </form>
  )
}
```

### Routing

Add `<Route path="/external-login-confirmation" element={<ExternalLoginConfirmation />} />` to the React Router config.

### Cookie expiry handling

The `__External` cookie has a **5-minute TTL**. If the user lingers between IdP callback and form submission, the cookie expires and the server returns `ExternalLoginFailure.aspx` instead of the confirmation form. The SPA detects this (no `input[name="Email"]` in the HTML) and shows an "expired" state with a link back to `/login`.

### Edge cases summary

| Case | Behavior |
|---|---|
| User has 2FA enabled | 2FA challenge happens AFTER `SignInAsync` completes (during the 302 navigation). SPA-ified confirmation doesn't interfere - 2FA challenge pages are server-rendered, separate flow. |
| `SameSite=Strict` cookie config | Fetch won't send `__External` cookie → `fetchExternalLoginDetails` throws `ExternalLoginCookieExpiredError` immediately. Default is `Lax` - works. |
| Invited user via external login | Invitation code captured from form action URL → preserved through POST → server redeems as part of contact creation. |
| Email mismatch with existing contact + `RequireUniqueEmail=true` | Server returns 200 with validation summary; SPA shows error inline. User can edit email and retry. |
| `AllowContactMappingWithEmail=true` and email matches existing contact | Server SKIPS the ExternalLoginConfirmation page entirely - user is signed in via the existing contact and lands at the return URL. The SPA page never mounts. |
