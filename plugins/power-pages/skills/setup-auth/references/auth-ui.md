# Authentication UI

#### 5.1 Create Auth Button Component

Based on the detected framework, create a login/logout button component:

- **React**: `src/components/AuthButton.tsx` + `src/components/AuthButton.css`
- **Vue**: `src/components/AuthButton.vue`
- **Angular**: `src/app/components/auth-button/auth-button.component.ts` + template + styles
- **Astro**: `src/components/AuthButton.astro`

The component should:

- Show a "Sign In" button when the user is not authenticated
- Show the user's display name and initials avatar as a dropdown trigger when authenticated; include "Sign Out" in the menu and "My Profile" only when enabled
- Include a loading state while checking auth status
- Be styled to match the site's existing design (read existing CSS variables/theme)

#### 5.1.1 Create Sign-In Page

> **Route naming - avoid server conflicts:** Power Pages reserves `/SignIn`, `/Register`, and all `/Account/Login/*` paths for server-rendered auth pages. SPA routes MUST NOT collide with these. Use `/login` for the sign-in page and `/registration` for the registration page.

Create `/login` for multiple providers, a local credential form, or an auth-error landing page.
Only a single external provider without those requirements may start login directly from AuthButton.

The Login page must:

Only import optional helpers when their feature is enabled.

- Import `AUTH_PROVIDERS`, `LOCAL_PROVIDER`, `EXTERNAL_PROVIDERS`, and `loginWithProvider` from authService
- Render every external provider as a button (loop `EXTERNAL_PROVIDERS`) - each button calls `loginWithProvider(provider, { returnUrl, invitationCode })`
- Render the local email/password form when `LOCAL_PROVIDER` exists. On submit, call `loginWithProvider(LOCAL_PROVIDER, { returnUrl, invitationCode, credentials: { credential, password, rememberMe } })`
- Use the credential field based on `LOCAL_PROVIDER.loginByEmail` - `Email` (type `email`) when `true`, `Username` (type `text`) when `false`
- Disable all buttons while any submission is in flight (an `isSubmitting` flag for local + `externalSubmittingId` for external)
- Catch `TermsRequiredError` from `loginWithProvider` and navigate to `/terms`
- Show the invitation banner when `invitationCode` is in the URL: "Sign in to redeem invitation {code}. The invitation will be linked to your account after you sign in."
- Show server-side auth errors parsed from `?message=` query params (via `getAuthError()`) and session-expired messages from `?sessionExpired=true` (via `getSessionExpiredMessage()`)
- Include a "Forgot password?" link to `/forgot-password` (SPA route) when `LOCAL_PROVIDER` exists and `ResetPasswordEnabled` is true
- Include a "Create an account" link to `/registration` when `REGISTRATION_MODE` is `Open registration only` or `Both` (omit for `Invitation-only` and `Registration disabled`)

**Render layout based on `LOGIN_LAYOUT` from Phase 2.1:**

| `LOGIN_LAYOUT` | Layout structure |
|---|---|
| `horizontal-row` (default) | External providers in a `flex-wrap` row at top, conditional divider, local form below. Each external button has `flex: 1 1 0; min-width: 0` and wraps long labels to two lines. |
| `vertical-stack` | External providers stacked full-width vertically, "OR SIGN IN WITH EMAIL" divider, local form below. Each external button is full card width. |
| `primary-spotlight` | The provider matching `PRIMARY_PROVIDER_ID` rendered as a large primary CTA. Other external providers tucked under a `<details>` disclosure labeled "More sign-in options" or "Other ways to sign in". Then divider + local form. |
| `tabbed` | A tab bar with one tab per provider (`displayName`). The selected tab's UI renders below. For external providers, the tab content is just the "Sign in with X" button; for local, it's the email/password form. |

Use the layout examples linked directly in SKILL.md when building provider selection UI.

When the `/login` page exists, the AuthButton's "Sign In" must navigate to `/login` (use `<Link to="/login">`) instead of calling any login function directly.

#### 5.1.2 Create Registration Page

**Always create the `/registration` page when `REGISTRATION_MODE` is not `Registration disabled`** - regardless of whether the mode is `Open registration only`, `Invitation-only`, or `Both`, and regardless of whether local or external providers (or both) are configured. The page mirrors the Login page layout when both local and external providers exist: external provider buttons in a horizontal row at the top, an "or sign up with email" divider, and the local registration form below (when local auth is configured). In invitation-only mode the page is reached via the `/redeem-invitation` flow (Phase 5.1.7) or via the server-bouncing flow (Code-Site-Shell-Header catches `/account/login/register`), not direct navigation - but the SPA route must still exist so React Router can render it.

> **Important architectural note:** The server-side registration page (`/Account/Login/Register`) is an ASP.NET Web Forms page, NOT an MVC action. The local `register()` function in authService handles this by first fetching the server page (GET), parsing the ViewState and control names, then POSTing with the correct payload. This only applies when the user submits the local registration form - external provider buttons skip this entirely and go through `loginExternal()`.

**External provider buttons (when `EXTERNAL_PROVIDERS.length > 0`):**

Render sign-up buttons using the chosen login layout.
Each calls `loginWithProvider(provider, { returnUrl, invitationCode })`, so workforce Entra also uses runtime identifier resolution.
The server then links or creates the contact, redeems an invitation, or displays external confirmation according to its settings.

If `EXTERNAL_PROVIDERS.length > 0` AND `LOCAL_PROVIDER` exists, show the divider ("or sign up with email") between the external buttons and the local form. If only external providers (no local), show ONLY the external buttons with no divider and no local form - the page becomes effectively "pick a provider to sign up with".

**Local form (when `LOCAL_PROVIDER` exists):**

The local registration form must:

- Call the `register()` function from authService, which handles the Web Forms ViewState pattern (fetch server page → parse → POST with correct control names)
- Show the correct credential field based on the `LocalLoginByEmail` choice from Phase 2.1:
  - **Email mode** (`LocalLoginByEmail = true`): Show an `Email` field (type `email`). This is both the login identifier and email address.
  - **Username mode** (`LocalLoginByEmail = false`): Show a `Username` field (type `text`) AND a separate `Email` field (type `email`). Both are required - Username is the login identifier, Email is needed for the contact record.
- Include `Password` and `Confirm Password` fields (both type `password`)
- Validate that passwords match client-side before submitting
- Display server-side registration errors parsed from `?message=` query params (via `getAuthError()`)
- Parse and pass through `invitationCode` from the URL query string (for invitation-based registration flows where the user arrives via `?invitationCode=...`)
- Include an "Already have an account? Sign in" link back to `/login`
- **Skip the auth redirect in development mode** - in dev mode the mock user is always "authenticated", which would block testing the registration form. Add: `const isDev = window.location.hostname === 'localhost'` and only redirect if `isAuthenticated && !isDev`.
- Be styled to match the site's existing sign-in page design (centered card layout)

**Layout** - matches the Login page (Phase 5.1.1). When the user picks `LOGIN_LAYOUT` in Phase 2.1, that layout choice (horizontal row / vertical stack / primary spotlight / tabbed) applies to both `/login` AND `/registration` so users get a consistent experience across the two pages.

**Pre-fill email from invitation (when `InvitationEnabled` is true - i.e., Invitation-only or Both modes):**

When the user arrives at `/registration?invitationCode=X`, the email field should pre-fill with the invited contact's email (matching the server-rendered page's behavior). Implement by calling `fetchInvitationDetails(invitationCode)` on mount:

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

The invitation reference linked in SKILL.md contains `fetchInvitationDetails()`, which parses the email from the server registration page's `#EmailTextBox` input.

The email input must be **controlled** (`value={email}`) and editable - the user can change it if needed (this matches server behavior).

**Framework-specific implementation:**

- **React**: Create `src/pages/Registration.tsx` and add `<Route path="/registration" element={<Registration />} />` to the router, adapting the entry-linked local registration template to the site's styles
- **Vue**: Create `src/pages/Registration.vue` and add the route to `src/router/index.ts`
- **Angular**: Create `src/app/pages/registration/registration.component.ts` and add the route to the router config
- **Astro**: Create `src/pages/registration.astro`

**If `REGISTRATION_MODE` is `Registration disabled`**, skip creating the `/registration` page entirely - there's no flow that should land users there.

#### 5.2 Integrate into Navigation

Find the site's navigation component and integrate the auth button:

1. Search for the nav/header component in the site's source code
2. Import the AuthButton component
3. **Replace any existing hardcoded sign-in link** (e.g., `<Link to="/login">Sign In</Link>` or `<a href="/signin">`) with the AuthButton component. The AuthButton reads `window.Microsoft.Dynamic365.Portal.User` to dynamically show either "Sign In" (when not authenticated) or the user's name + avatar + "Sign Out" button (when authenticated). A hardcoded link does not react to auth state.
4. **If multiple providers are configured**: The AuthButton's "Sign In" action should navigate to `/login` page
5. **If a single external provider and no Login page**: Start login directly; a single local provider still needs its credential form
6. **Verify** after integration that the Navbar does NOT have both a hardcoded sign-in link AND the AuthButton - there must be exactly one auth entry point in the navigation.
