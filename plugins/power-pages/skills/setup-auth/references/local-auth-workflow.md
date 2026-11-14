# Explicitly requested local authentication

Run only when local authentication is explicitly requested or already configured and retained.
Use the local service template and enabled reset-password flow listed in SKILL.md.
Never offer or scaffold built-in Power Pages 2FA.

**For "Local Authentication"** (only if user explicitly requested it): Ask the user how they want users to identify themselves when logging in:

| Question | Options |
|----------|---------|
| How should users log in with their local account? | Login by email (Recommended) - Users sign in with their email address, Login by username - Users sign in with a chosen username |

This choice determines the `Authentication/Registration/LocalLoginByEmail` site setting (`true` for email, `false` for username) and affects every form field in the login, registration, and auth service code. When **email** is chosen, the login and registration forms show an `Email` field (type `email`). When **username** is chosen, the forms show a `Username` field (type `text`) and `Email` becomes a separate required field on the registration form (the server needs it for the contact record). Store this choice - it will be used in Phase 3 (auth service), Phase 5 (sign-in and registration pages), and Phase 8.1 (site settings).

**For "Local Authentication"** - also ask which registration mode the site should use:

| Question | Options |
|----------|---------|
| How should users be able to register on your site? | Open registration only (Recommended) - Anyone can sign up freely with a username/password, Invitation-only - Only users with a valid invitation code can register; direct registration is blocked, Both - Users can self-register OR redeem an invitation link, Registration disabled - No new accounts can be created (only existing users can log in) |

**Why this matters** - the server enforces the following gating rules in `RegistrationManager`:

| Mode | `Enabled` | `OpenRegistrationEnabled` | `InvitationEnabled` | Behavior |
|---|---|---|---|---|
| Open registration only | `true` | `true` | `false` | Direct `/registration` works. Invitation links return 404. |
| Invitation-only | `true` | `false` | `true` | Direct `/registration` returns 404. Users must arrive via invitation link → `/redeem-invitation` → `/registration?invitationCode=...`. |
| Both | `true` | `true` | `true` | Both paths work. Invitation pre-fills email; direct registration is fully open. |
| Registration disabled | `false` | (moot) | (moot) | All registration endpoints return 404. Existing users can still log in. |

> **Note:** The `Authentication/Registration/RequireInvitationCode` setting is NOT a real server setting - the server doesn't read it. The "require invitation" behavior is enforced solely by `OpenRegistrationEnabled = false` + `InvitationEnabled = true`. Do not create that setting.

Store this choice as `REGISTRATION_MODE` - it drives:
- Whether to create the `/registration` page (always, unless `Registration disabled`)
- Whether to create the `/redeem-invitation` page (only when `InvitationEnabled` is true, i.e., `Invitation-only` or `Both`)
- Whether the `/registration` page calls `fetchInvitationDetails()` to pre-fill the email (only when `InvitationEnabled` is true)
- The deterministic set of site settings written in Phase 8.1
- The CAPTCHA compatibility warning for a SPA form and the server settings below

#### 5.1.3 Create Forgot Password Page (Local Auth Only)

**If local authentication is configured AND `ResetPasswordEnabled` is `true`**, create a `/forgot-password` page. This is a simple form that collects the user's email and POSTs to the server, which sends a password reset link via email.

> **Note:** The forgot password endpoint (`/Account/Login/ForgotPassword`) is an MVC form (like login), NOT a Web Forms page (like registration). A simple `fetch()` POST with `Email` + `__RequestVerificationToken` works. The `forgotPassword()` function in authService handles this.

The forgot password page must:

- Show an email input field
- Call `forgotPassword(email)` from authService on submit
- **Handle both success and error**: Use `.then()` for success (show "Check your email" confirmation with green checkmark, hide the form) and `.catch()` for errors (show error inline, reset button). Do NOT only handle `.catch()` - the button will get stuck in "Sending..." state if `.then()` is not handled.
- Track `emailSent` state - when true, replace the form with a success message: "We've sent a password reset link to your email address. Please check your inbox and follow the instructions." with a "Back to sign in" link
- Display server errors inline (the `forgotPassword()` function uses fetch and throws parsed errors)
- Include a "Back to sign in" link to `/login`
- Use the same validate-on-blur pattern as login and registration (validate email format on blur, clear on change)

The login page's "Forgot password?" link should point to `/forgot-password` (SPA route), NOT `/Account/Login/ForgotPassword` (server URL).

After the server processes the request, it sends a reset email. The reset link in the email points to the server's `/Account/Login/ResetPassword?UserId=...&Code=...` - but this gets intercepted by the Header template redirect script (see Phase 5.1.6) and redirected to the SPA `/reset-password` page.

#### 5.1.4 Validation Pattern for All Auth Pages (Local Auth Only)

All local auth pages (login, registration, forgot password) must implement **validate-on-blur, clear-on-change** for real-time field validation. This is the modern UX pattern - errors appear when the user leaves a field and disappear as they correct it.

**Implementation pattern:**

1. Track `touched` state per field (which fields the user has interacted with)
2. **On blur** (`onBlur`): mark field as touched, run validation, show error immediately
3. **On change** (`onChange`): if the field was already touched, re-validate and clear the error as soon as the value becomes valid. Also clear server errors on any change.
4. **On submit**: mark ALL fields as touched, validate everything, show all errors at once
5. `showError(field)` helper: only return the error if the field has been touched

**Validation rules:**

| Page | Field | Validation |
|------|-------|-----------|
| Login | Email | Required + valid email format |
| Login | Password | Required |
| Registration | Email | Required + valid email format |
| Registration | Password | Required + min 8 chars + characters from at least 3 of 4 categories (lowercase, uppercase, digit, special character) |
| Registration | Confirm Password | Required + must match Password |
| Forgot Password | Email | Required + valid email format |

The password strength validation matches the default Power Pages password policy (`EnforcePasswordPolicy`). If the site creator customizes the password policy via `Authentication/UserManager/PasswordValidator/*` site settings, the client-side validation should match.

**Local Authentication** - write these settings based on the user's choices from Phase 2.1.

**Settings always written (regardless of registration mode):**

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/LocalLoginEnabled" \
  --value "true" \
  --description "Enable local username/password login" \
  --type boolean

# Set to "true" if the user chose email login, "false" if they chose username login (Phase 2.1)
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/LocalLoginByEmail" \
  --value "<true-or-false-from-user-choice>" \
  --description "Login by email (true) or username (false)" \
  --type boolean

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/ResetPasswordEnabled" \
  --value "true" \
  --description "Enable forgot password flow for local accounts" \
  --type boolean
```

**Registration mode settings** - deterministic mapping from `REGISTRATION_MODE`:

| `REGISTRATION_MODE` | `Authentication/Registration/Enabled` | `Authentication/Registration/OpenRegistrationEnabled` | `Authentication/Registration/InvitationEnabled` |
|---|---|---|---|
| Open registration only | `true` | `true` | `false` |
| Invitation-only | `true` | `false` | `true` |
| Both | `true` | `true` | `true` |
| Registration disabled | `false` | (skip - moot) | (skip - moot) |

> **External-provider sites (no local auth):** when the user did NOT choose Local Authentication, `REGISTRATION_MODE` is not collected. Instead honor `OPEN_REGISTRATION_CHOICE` from Phase 2.1.2 (the Phase 2.1.2 open-registration question): write `Authentication/Registration/OpenRegistrationEnabled` = `true` for **Open - self-service**, `false` for **Controlled - pre-provisioned only**. Do not write `Enabled`/`InvitationEnabled` in this case (they govern the local registration pages, which an external-only site doesn't scaffold). If neither `REGISTRATION_MODE` nor `OPEN_REGISTRATION_CHOICE` was collected, skip these settings and let the server defaults apply.

> **Do NOT create the `Authentication/Registration/RequireInvitationCode` setting.** It does not exist on the server (the server never reads it). The invitation-only behavior is enforced entirely by `OpenRegistrationEnabled = false` + `InvitationEnabled = true`. Earlier versions of this skill wrote this setting - if you find it in the project's site settings (`.powerpages-site/site-settings/Authentication-Registration-RequireInvitationCode.sitesetting.yml`), **delete the file** as part of the setup.

Example (write each setting that applies - skip Enabled/OpenReg/Invitation when mode is `Registration disabled` except `Enabled=false`):

```bash
# For all modes EXCEPT "Registration disabled":
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/Enabled" \
  --value "true" \
  --description "Master switch: registration is enabled" \
  --type boolean

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/OpenRegistrationEnabled" \
  --value "<true-or-false-from-mode>" \
  --description "Allow self-registration without an invitation" \
  --type boolean

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/InvitationEnabled" \
  --value "<true-or-false-from-mode>" \
  --description "Enable invitation-based registration" \
  --type boolean

# For "Registration disabled" mode ONLY:
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/Enabled" \
  --value "false" \
  --description "Disable all registration (only existing users can sign in)" \
  --type boolean
```

**CAPTCHA settings** - conditional on mode:

| `REGISTRATION_MODE` | `CaptchaEnabled` / `IsCaptchaEnabledForRegistration` | Reason |
|---|---|---|
| Open registration only / Both | `false` (with note) | The SPA registration form cannot render the server-side CAPTCHA widget - leaving it on causes registration to silently fail. For production, the site owner should add their own client-side CAPTCHA solution and re-enable the server setting. |
| Invitation-only | `false` | Invitations already filter users - CAPTCHA adds friction without security value. |
| Registration disabled | (skip - registration is off) | - |

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/CaptchaEnabled" \
  --value "false" \
  --description "Disable server-rendered CAPTCHA - SPA cannot render the widget" \
  --type boolean

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/IsCaptchaEnabledForRegistration" \
  --value "false" \
  --description "Disable server-rendered CAPTCHA on registration form" \
  --type boolean
```

**Local Authentication optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `Authentication/Registration/OpenRegistrationEnabled` | Allow self-registration | `true` |
| `Authentication/Registration/EmailConfirmationEnabled` | Require email confirmation on registration | `false` |
| `Authentication/Registration/ResetPasswordEnabled` | Enable forgot password flow | `true` |
| `Authentication/Registration/ResetPasswordRequiresConfirmedEmail` | Require confirmed email before allowing password reset | `false` |
| `Authentication/Registration/RequireUniqueEmail` | Enforce unique email addresses | `false` |
| `Authentication/Registration/TermsAgreementEnabled` | Require terms & conditions agreement on registration. The server redirects to a Terms page before completing registration. | `false` |
| `Authentication/Registration/IsCaptchaEnabledForRegistration` | Show CAPTCHA on registration form | `false` |
| `Authentication/Registration/TriggerLockoutOnFailedPassword` | Lock account after too many failed login attempts | `true` |
| `Authentication/Registration/DenyMinors` | Deny registration for users identified as minors | `false` |
| `Authentication/Registration/DenyMinorsWithoutParentalConsent` | Deny minors without parental consent (requires GDPR to be enabled) | `false` |

### React: LocalLoginForm Component (Local Auth Only)

When the provider type is `local`, also create `src/components/LocalLoginForm.tsx`. This component handles:
- Login with email or username (based on `loginByEmail` setting)
- Server-side auth error display (parsed from `?message=` query params)
- Link to forgot password page
- Link to registration page (when `OpenRegistrationEnabled` is true)

Template: `assets/local-auth-react-localloginform-component-local-auth-only.tsx.template` (listed directly in SKILL.md).

> **Note on "Create an account" link:** Only add a registration link (`<a href="/registration">Create an account</a>`) to the login form when `OpenRegistrationEnabled` is `true`. Since this is a server-side setting, the skill should include the link when it creates the `LocalLoginForm` and the `OpenRegistrationEnabled` site setting is being set to `true`. If the user chose invitation-only registration (where `OpenRegistrationEnabled` is `false`), omit the link - users register via invitation links instead.

### React: RegisterForm Component (Local Auth Only)

When local authentication and registration are enabled, create `src/pages/Registration.tsx` and a `/registration` route, not the server-reserved `/register`.
Skip the page and RegisterForm entirely for `Registration disabled`.
The form calls `register()` from authService, which handles Web Forms ViewState internally.

> **Dev mode:** The registration page should skip the auth redirect when running on localhost, because the mock user is always "authenticated" and would prevent testing the form. Add: `const isDev = window.location.hostname === 'localhost'` and only redirect if `isAuthenticated && !isDev`.

Template: `assets/local-auth-react-registerform-component-local-auth-only.tsx.template` (listed directly in SKILL.md).

Adapt the forms to the site's theme and create their imported `src/components/LocalLoginForm.css`.
The shared AuthButton stylesheet is listed separately in SKILL.md and is not the local-form stylesheet.

This is extensible - additional server-to-SPA redirects can be added to the `redirects` object (e.g., for email confirmation pages).

**2. SPA Reset Password Page**

Create a `/reset-password` page that:

- Reads `UserId` and `Code` from the URL query params (preserved by the header redirect)
- Shows "Invalid Reset Link" with a link to `/forgot-password` if either param is missing
- Shows new password + confirm password fields with validate-on-blur (password strength validation same as registration)
- Calls `resetPassword(userId, code, password, confirmPassword)` from authService on submit
- On success, redirects to `/login?message=password_reset_success`
- On error, shows server errors inline

The `resetPassword()` function is an MVC form POST (no ViewState) to `/Account/Login/ResetPassword` with fields: `__RequestVerificationToken`, `UserId`, `Code`, `Password`, `ConfirmPassword`. Note: the password field is `Password` here (NOT `PasswordValue` like login - different endpoints use different field names).

**Login page must handle the success message**: Check for `?message=password_reset_success` in the URL on mount and display a green success banner: "Your password has been reset. Please sign in with your new password."

**Framework-specific implementation:**
- **React**: Create `src/pages/ResetPassword.tsx` and add `<Route path="/reset-password" element={<ResetPassword />} />` to the router

## Reset Password Flow for SPA Sites

### The Problem

The password reset email sends the user to `/Account/Login/ResetPassword?UserId=...&Code=...` - a server-rendered page outside the SPA. The user leaves the SPA experience.

### The Solution: Code-Site-Shell-Header Template

Create the shell template linked directly in SKILL.md with the reset-password redirect enabled.
Bind it through `website.yml`; preserve `UserId` and `Code` in the query string.
Create `/reset-password`, validate password/confirmation, call `resetPassword()` and show server errors inline.

### Login Page: Password Reset Success Message

The Login page must check for `?message=password_reset_success` on mount:

```typescript
const params = new URLSearchParams(window.location.search)
if (params.get('message') === 'password_reset_success') {
  setSuccessMessage('Your password has been reset. Please sign in with your new password.')
}
```

Display it as a green success banner above the form (distinct from the red error banner).

### Forgot Password Page: Success State

The ForgotPassword page must handle both `.then()` and `.catch()` from `forgotPassword()`:

```typescript
forgotPassword(email).then(() => {
  setIsSubmitting(false)
  setEmailSent(true)       // triggers success UI
}).catch(err => {
  setServerError(err.message)
  setIsSubmitting(false)
})
```

When `emailSent` is true, replace the form with a success confirmation: green checkmark icon, "Check your email" heading, and a "Back to sign in" link. Do NOT only handle `.catch()` - the button gets stuck in "Sending..." if `.then()` is not handled.

### Complete Password Reset Flow

1. User clicks "Forgot password?" on login → SPA `/forgot-password`
2. Enters email → `forgotPassword()` POSTs to server → success message "Check your email"
3. User opens email → clicks reset link → browser goes to `/Account/Login/ResetPassword?UserId=...&Code=...`
4. **Header template script fires** → `window.location.replace` to `/reset-password?UserId=...&Code=...`
5. SPA loads → ResetPassword page reads params → shows new password form
6. User submits → `resetPassword()` POSTs to server → redirect to `/login?message=password_reset_success`
7. Login page shows green "Password has been reset" banner

---
