# Invitation registration

#### 5.1.7 Create Redeem Invitation Page (Invitation Modes Only)

**If `REGISTRATION_MODE` is `Invitation-only` or `Both`**, create a `/redeem-invitation` SPA page. This is the landing page users hit when they click an invitation email link. The link format is `{site-url}/Account/Login/RedeemInvitation?invitation={code}` - the Code-Site-Shell-Header redirect (Phase 5.1.6) catches it and forwards to the SPA route.

**Two paths land users on `/redeem-invitation`:**

1. **Direct invitation link**: User clicks the email link `/Account/Login/RedeemInvitation?invitation={code}` → header script redirects to `/redeem-invitation?invitation={code}`. Clean SPA entry - invitation code in URL from the start.

2. **Server-bounce path (external auth, no contact, no invitation)**: User clicks "Sign in with [external provider]" on the Login page WITHOUT first clicking an invitation link. They complete external auth, the server's `ExternalLoginCallback` finds no contact + no invitation, and redirects them to `/Register?ReturnUrl=...` (the alias for `LoginController.RedeemInvitation`). The header script catches `/register` and redirects to `/redeem-invitation` - same SPA page, no invitation code pre-filled, user types it in. This path applies to **all external providers**, not just Entra External ID - the server-side bouncing logic is provider-agnostic. **Confirmed via HAR analysis on a live site with Entra External ID + Terms.**

**Server flow this replaces:** The server's `LoginController.RedeemInvitation` action (the server's authentication controller) validates the invitation code and branches:

- **RedeemByLogin = false** (new user) → 302 redirect to `/Account/Login/Register?invitationCode={code}` - server expects registration with the code
- **RedeemByLogin = true** (existing user) → 200 OK with Login view, invitation code embedded in the form action URL - server expects sign-in, then redeems invitation in `RedirectOnPostAuthenticate` after auth
- **Invalid / expired / already-redeemed code** → 200 OK with form re-rendered, error in `#redeemInvitation-validation-summary` (all three conditions surface the same `Invalid_Invitation_Code_Exception`)

**SPA design - fully replaces the server-rendered page:**

The SPA page calls `redeemInvitation(code, redeemByLogin)` from authService, which uses `fetch()` with `redirect: 'manual'` to intercept the server's 302 redirect. Based on the response:

- `response.type === 'opaqueredirect'` → server validated code + would have redirected to Register → SPA navigates to `/registration?invitationCode={code}` (existing page from Phase 5.1.2)
- 200 OK with Login form markers in HTML → user wanted login flow → SPA navigates to `/login?invitationCode={code}` (existing page - must also be updated, see below)
- 200 OK with validation summary in HTML → invalid code → throw parsed server error (use existing `parseServerErrors()` helper)

> **DevTools artifact**: After the POST, the browser's network panel will show the 302 Location target (e.g., `/Account/Login/Register`) as an aborted (`net::ERR_ABORTED`) request. This is expected - it's the redirect we intentionally chose not to follow via `redirect: 'manual'`. The flow uses `response.type === 'opaqueredirect'` to detect the redirect occurred without actually following it.

The redeem invitation page must:

- Read `invitation` or `InvitationCode` from the URL query (handle both casings - emails may use either)
- Pre-fill the invitation code input but keep it editable (in case user types it in manually with no email link)
- Show a checkbox: **"Sign in with an existing account instead of registering"** (this controls `RedeemByLogin`)
- Validate-on-blur: invitation code required and non-empty
- On submit, call `redeemInvitation()` and navigate based on the returned `nextStep`
- Display server errors inline (parsed via existing `parseServerErrors`)
- Include a "Back to sign in" link to `/login`
- Be styled to match the rest of the auth pages

**Login page update (required):**

The Login page (Phase 5.1.1) must also be updated when invitation mode is enabled:

1. Read `invitationCode` from URL query params on mount
2. If present, show an info banner: `"Sign in to redeem invitation {code}. The invitation will be linked to your account after you sign in."`
3. Pass `invitationCode` to `loginLocal()` as the new 5th parameter - the auth service appends it as `?InvitationCode={code}` on the `/SignIn` POST URL. The server's `Login(model, returnUrl, invitationCode)` handler reads this and redeems the invitation in `RedirectOnPostAuthenticate` after successful authentication.

**Framework-specific implementation:**

- **React**: Create `src/pages/RedeemInvitation.tsx` and add `<Route path="/redeem-invitation" element={<RedeemInvitation />} />` to the router, using the implementation below.
- **Vue / Angular / Astro**: Mirror the React pattern in the framework's idioms.

**Auth service additions** (required when invitation mode is enabled):

- `redeemInvitation(invitationCode, redeemByLogin, returnUrl)` - use the implementation below
- `fetchInvitationDetails(invitationCode)` - already covered in Phase 5.1.2 for email pre-fill
- `loginLocal()` updated to accept optional `invitationCode` parameter (5th arg) - appends `?InvitationCode={code}` to the `/SignIn` URL

### Auth service additions

#### `redeemInvitation()` - the core function

Add to `src/services/authService.ts`:

```typescript
export interface RedeemInvitationResult {
  nextStep: 'register' | 'login';
}

export async function redeemInvitation(
  invitationCode: string,
  redeemByLogin: boolean,
  returnUrl: string = '/'
): Promise<RedeemInvitationResult> {
  if (!invitationCode) {
    throw new Error('Invitation code is required.');
  }

  if (isDevelopment) {
    return { nextStep: redeemByLogin ? 'login' : 'register' };
  }

  const token = await fetchAntiForgeryToken();

  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', token);
  body.set('InvitationCode', invitationCode);
  body.set('RedeemByLogin', redeemByLogin ? 'true' : 'false');
  body.set('returnUrl', returnUrl);

  const response = await fetch('/Account/Login/RedeemInvitation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'manual',
  });

  // Branch 1: server returned a 302 redirect (caught by redirect:'manual').
  // Code is valid AND RedeemByLogin was false → server would have sent us to
  // /Account/Login/Register. We don't follow it - we navigate to our SPA /registration.
  if (response.type === 'opaqueredirect') {
    return { nextStep: 'register' };
  }

  // Branch 2: 200 OK - could be Login view (RedeemByLogin=true) or validation error.
  if (response.ok) {
    const html = await response.text();

    // 2a: Validation error (invalid/expired/already-redeemed code)
    const errors = parseServerErrors(html);
    if (errors.length > 0) {
      throw new Error(errors.join(' '));
    }

    // 2b: Login view returned - server expects user to sign in with existing account
    if (html.includes('name="PasswordValue"') || html.includes('LoginLocal')) {
      return { nextStep: 'login' };
    }

    throw new Error('Unable to process invitation. Please try again.');
  }

  throw new Error(`Failed to redeem invitation (status ${response.status}).`);
}
```

> **DevTools note**: After the POST resolves with `opaqueredirect`, Chrome's network panel will show the 302 Location target (e.g., `/Account/Login/Register`) as an aborted request with `net::ERR_ABORTED`. This is **expected** and not an actual error - it's the redirect we intentionally chose not to follow. The fast (~0.3ms) timing and the matching URL confirm it's the redirect target, not a network failure.

#### `fetchInvitationDetails()` - for email pre-fill on Registration page

Add to `src/services/authService.ts`:

```typescript
export interface InvitationDetails {
  email: string;
}

export async function fetchInvitationDetails(invitationCode: string): Promise<InvitationDetails> {
  if (!invitationCode) return { email: '' };

  if (isDevelopment) {
    return { email: 'invitee@contoso.com' };
  }

  const regUrl = `/Account/Login/Register?invitationCode=${encodeURIComponent(invitationCode)}`;
  const response = await fetch(regUrl, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Failed to load invitation details (status ${response.status}).`);

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const emailInput = doc.getElementById('EmailTextBox') as HTMLInputElement | null;
  const email = emailInput?.getAttribute('value') || '';

  return { email };
}
```

### React: RedeemInvitation page

Create `src/pages/RedeemInvitation.tsx`:

```typescript
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { redeemInvitation } from '../services/authService'

const validateCode = (v: string) => {
  if (!v || !v.trim()) return 'Invitation code is required'
  return ''
}

export default function RedeemInvitation() {
  const navigate = useNavigate()

  const initialCode = (() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('invitation') || params.get('InvitationCode') || params.get('code') || ''
  })()

  const [code, setCode] = useState(initialCode)
  const [redeemByLogin, setRedeemByLogin] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [serverError, setServerError] = useState<string | undefined>()
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => { document.title = 'Redeem Invitation' }, [])

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setTouched({ code: true })
    const error = validateCode(code)
    setErrors(error ? { code: error } : {})
    if (error) return

    setIsSubmitting(true)
    setServerError(undefined)

    redeemInvitation(code.trim(), redeemByLogin).then(result => {
      const target = result.nextStep === 'register' ? '/registration' : '/login'
      navigate(`${target}?invitationCode=${encodeURIComponent(code.trim())}`)
    }).catch(err => {
      setServerError(err instanceof Error ? err.message : 'Unable to verify invitation.')
      setIsSubmitting(false)
    })
  }

  // ... render form with invitation code input + "Sign in with an existing account
  // instead of registering" checkbox + Continue button (see contoso-portal site for
  // a complete styled example) ...
}
```

### Login page update

When `REGISTRATION_MODE` is `Invitation-only` or `Both`, update Login.tsx to:

1. Read `invitationCode` from URL on mount:
   ```typescript
   const invitationCode = new URLSearchParams(window.location.search)
     .get('invitationCode') || undefined
   ```
2. Show an info banner when present: `"Sign in to redeem invitation {code}. The invitation will be linked to your account after you sign in."`
3. Pass `invitationCode` to `loginLocal(email, password, rememberMe, '/', invitationCode)` on submit.

### Registration page update - email pre-fill + external provider buttons

When `REGISTRATION_MODE` is `Invitation-only` or `Both`, update Registration.tsx to call `fetchInvitationDetails(invitationCode)` on mount and pre-fill the email input. The input must be controlled (`value={email}`) and editable.

```typescript
useEffect(() => {
  if (!invitationCode) return
  fetchInvitationDetails(invitationCode).then(details => {
    if (details.email) setEmail(details.email)
  }).catch(() => {
    setServerError('Could not pre-fill the invited email. Enter it manually or retry.')
  })
}, [invitationCode])
```

When external providers exist, render their buttons using the selected login layout.
Call `loginWithProvider` so provider identifiers, including workforce Entra's runtime tenant, are resolved consistently.
The invitation code travels through the IdP round trip and is redeemed after authentication.

```tsx
{EXTERNAL_PROVIDERS.length > 0 && (
  <div style={styles.externalRow}>
    {EXTERNAL_PROVIDERS.map(provider => (
      <button key={provider.id} type="button"
        onClick={() => loginWithProvider(provider, { returnUrl: '/', invitationCode }).catch(err => setServerError(err.message))}>
        {`Sign up with ${provider.displayName.replace(/^Sign in with /, '')}`}
      </button>
    ))}
  </div>
)}
{EXTERNAL_PROVIDERS.length > 0 && LOCAL_PROVIDER && <Divider label="OR SIGN UP WITH EMAIL" />}
{LOCAL_PROVIDER && <LocalRegistrationForm ... />}
```

### End-to-end flow summary

**Path A - User clicks invitation email link first (clean SPA entry):**
1. Admin creates an Invitation record in Dataverse (`adx_invitation` table) for an invited contact → captures `adx_invitationcode`
2. Admin sends user a link: `{site-url}/Account/Login/RedeemInvitation?invitation={code}`
3. User clicks → browser loads server page → header template script redirects to SPA `/redeem-invitation?invitation={code}`
4. SPA RedeemInvitation page mounts → code pre-filled → user picks register vs. login → submits
5. `redeemInvitation()` POSTs → server validates code → returns 302 (register) or 200 (login)
6. SPA detects branch and navigates to `/registration?invitationCode={code}` or `/login?invitationCode={code}`
7. **Register path with local auth**: Registration page pre-fills email via `fetchInvitationDetails()` → user completes form → POST creates account AND redeems invitation in one server call
8. **Register path with external auth**: User clicks external provider button on `/registration` → `loginExternal()` POSTs to `/Account/Login/ExternalLogin?InvitationCode={code}` → IdP → ExternalLoginCallback creates contact + redeems invitation
9. **Login path**: Login page shows info banner → user signs in (local or external - both thread `invitationCode` through) → server redeems invitation in `RedirectOnPostAuthenticate` after auth

**Path B - User clicks "Sign in with external provider" without invitation context (server-bounce path):**
1. User clicks external provider button on `/login` (or directly via `loginExternal()` from the Nav) - **no invitation code in URL**
2. `POST /Account/Login/ExternalLogin?Provider=...` → IdP → `/signin-{providername}` → 302 → `/Account/Login/ExternalLoginCallback?ReturnUrl=/`
3. **`GET /Account/Login/ExternalLoginCallback`**: server detects no contact + no invitation → 302 → `/Register?ReturnUrl=/` (the alias route for `LoginController.RedeemInvitation`, NOT the local Register page)
4. Code-Site-Shell-Header script catches `/register` → redirects to SPA `/redeem-invitation`
5. User enters invitation code → SPA `redeemInvitation()` → server returns 302 → `/Account/Login/Register?returnUrl=/&invitationCode={code}` (the local Register Web Forms page)
6. Header script catches `/account/login/register` → redirects to SPA `/registration?invitationCode={code}`
7. SPA Registration page mounts. External provider buttons visible at top. User clicks "Sign up with [external provider]" → `loginExternal(providerIdentifier, '/', invitationCode)`
8. `POST /Account/Login/ExternalLogin?InvitationCode={code}&Provider=...` → IdP (silent - cookies still valid from step 2) → `/signin-{providername}` → `/Account/Login/ExternalLoginCallback?InvitationCode={code}`
9. ExternalLoginCallback now has BOTH external auth + invitation → creates contact + redeems → 302 to ReturnUrl (or Terms if enabled)

> **Why the bounce?** The server's `RegistrationManager` enforces that external-authenticated users without a contact MUST either (a) have an invitation, or (b) be in a configuration where `OpenRegistrationEnabled = true` AND `AllowContactMappingWithEmail = true`. Without those, the server forces the invitation flow via the alias `/Register` route. The header redirect catches the bounce and keeps the user in the SPA throughout.

> **Verified via HAR analysis** on a live Power Pages site (smoking-burgers-inc) with Entra External ID + Terms enabled. The two new redirects (`/register` and `/account/login/register`) are critical for any site with external providers AND invitations enabled - without them, users see two server-rendered pages (RedeemInvitation form + local Register Web Forms page) in the middle of the flow.

---
