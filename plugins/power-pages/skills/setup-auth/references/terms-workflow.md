# Terms and conditions

## Contents

- [Create the SPA page](#515-create-terms-and-conditions-page-when-terms-enabled)
- [Service and redirect detection](#auth-service-termsrequirederror-and-acceptterms)
- [Page example](#react-terms-page-component)
- [Snippets](#content-snippets-used-by-the-server)
- [Settings](#site-settings-and-snippets)

<!-- not-a-gate: terms options collect configuration; the final implementation approval remains setup-auth:2.2.plan-approval. -->

**If "Terms and Conditions" is selected**, first surface the GDPR prerequisite **before** collecting content - terms only function if the underlying solution is installed:

> **GDPR prerequisite**: Terms require ALL THREE of these to be in place for the server to actually enforce them:
> 1. `Authentication/Registration/TermsAgreementEnabled = true` (site setting we will create)
> 2. The `msdynce_PortalPrivacyExtensions` solution must be installed in your Dataverse environment (`IsGdprEnabled` is portal-level)
> 3. The `Account/Signin/TermsAndConditionsCopy` content snippet must have non-empty text (we will create this)
>
> Without the Privacy Extensions solution, the server ignores `TermsAgreementEnabled`.
> This skill can create the page, setting and snippets, but cannot install the solution.

**Auto-detect the Privacy Extensions solution before asking.** Run:

```bash
node "${PLUGIN_ROOT}/scripts/check-solution-installed.js" --solutionName "msdynce_PortalPrivacyExtensions"
```

The script prints JSON to stdout: `{ "installed": true, "version": "..." }` if found, or `{ "installed": false }` if the solution isn't in the environment. On infrastructure failure (no PAC environment, expired Azure CLI token, missing Read permission on the solutions table, network error), it exits non-zero and writes a human-readable reason to stderr.

Branch on the result:

| Script result | What to do |
|---|---|
| `installed: true` | Skip the prereq question entirely and proceed to collecting terms content (next section). Briefly tell the user: *"Confirmed `msdynce_PortalPrivacyExtensions` v{version} is installed in your environment - terms enforcement will work."* |
| `installed: false` | **Tell the user clearly that terms and conditions will NOT work**: *"The `msdynce_PortalPrivacyExtensions` solution is NOT installed in your Dataverse environment. The Terms and Conditions feature will NOT be enforced by the server until that solution is installed - `Authentication/Registration/TermsAgreementEnabled` is silently ignored without it. The site setting, Terms page, and content snippets will still be scaffolded, but the gate is a no-op until the solution is in place."* Then ask directly: **header** "Privacy solution", **question** "Would you still like to set up Terms and Conditions now (it can be enabled later once you install the solution), or skip it?", **options**: "Continue anyway - scaffold the Terms infrastructure; I'll install the solution later", "Cancel - skip Terms and Conditions for this site". |
| Script exited non-zero (infrastructure failure) | Tell the user we couldn't auto-detect the solution (include the stderr message succinctly so they understand why - e.g., "couldn't reach Dataverse", "missing permissions on the solutions table"). Fall back to the manual prompt: **question** "We couldn't auto-detect whether `msdynce_PortalPrivacyExtensions` is installed. Do you have the GDPR/Privacy Extensions solution installed?", **options**: "Yes - solution is installed (or I'll install it)", "Continue anyway - set up terms; I understand they won't be enforced until I install the solution", "Cancel - I don't want terms". |

**If the user picks "Cancel" (in either the not-installed or fallback path)**: skip the Terms branch entirely, do not set `TermsAgreementEnabled`, do not create the Terms page or snippets.
Record `termsPrerequisiteStatus` as `detected`, `missing` or `unverified`; use `disabled` when the branch is skipped.
A failed check remains `unverified` even if the user promises to install the solution.
Set report `termsEnforced=true` only after a successful detection and the required setting and nonempty snippet are present.
Otherwise keep it false, explain the missing or unverified prerequisite and do not claim live enforcement was tested.

Otherwise, collect the terms content. The server uses 4 content snippets - the skill hardcodes these values into the SPA Terms page component. Ask the user:

| Question | Header | Options |
|----------|--------|---------|
| What terms text should be shown to users? You can provide HTML or plain text. | Terms Content | Use default terms (Recommended) - Generic terms covering data use, account responsibility, and acceptable use, I'll provide my own terms text |

Use custom terms text when supplied.
Otherwise draft generic account-responsibility, data-use and acceptable-use terms for the user to confirm; do not present them as legal advice.

Also collect optional customizations:

| Question | Header | Options |
|----------|--------|---------|
| Would you like to customize the terms page labels? | Labels | Use defaults (Recommended) - heading: "Terms and Conditions", checkbox: "I agree to these terms and conditions.", button: "Confirm", I'll customize the labels |

Store these 4 values - they'll be hardcoded into the Terms page component in Phase 5 and created as content snippets in Phase 8.1:
- `TERMS_HEADING` (default: "Terms and Conditions")
- `TERMS_CONTENT` (default: generic terms HTML)
- `TERMS_AGREEMENT_TEXT` (default: "I agree to these terms and conditions.")
- `TERMS_BUTTON_TEXT` (default: "Confirm")

Optionally ask about `TermsPublicationDate`:

| Question | Header | Options |
|----------|--------|---------|
| When should users be re-prompted to accept terms? | Re-consent | Every login (no publication date) - users accept terms every time they sign in, Set a publication date - users re-accept only when terms are updated past this date |

If "Set a publication date", collect the date. The format should be ISO: `YYYY-MM-DD` (e.g., `2026-01-01`). If "Every login", leave `TermsPublicationDate` unset.

#### 5.1.5 Create Terms and Conditions Page (When Terms Enabled)

**If the user enabled Terms and Conditions in Phase 2**, create a `/terms` SPA page. **This page works for ALL auth flows** - local sign-in, local registration, AND external providers (Entra External ID, OIDC, social) - via two complementary mechanisms:

1. **Local auth flows** (`loginLocal`, `register`): use `fetch()` so the SPA stays in-page. The auth service detects the server's `TermsAndConditions` redirect from `response.url` and throws `TermsRequiredError`. The login/registration page catches it and navigates to `/terms`.
2. **External auth flows** (`loginExternal`, `loginWithProvider` external branch): use `form.submit()` so the browser leaves the SPA during the IdP round-trip. After IdP callback, the server may redirect to `/Account/Login/TermsAndConditions?ReturnUrl=/&UseExternalSignInAsync=True&IsFacebook=False&IsInternalAADUser=False`. The Code-Site-Shell-Header script (Phase 5.1.6) catches this URL and redirects to the SPA `/terms` route, preserving the query string so `acceptTerms()` knows which sign-in completion path the server expects.

The terms page must:

- Hardcode the 4 snippet values collected in Phase 2 as constants at the top of the component:
  ```typescript
  const TERMS_HEADING = '<value from Phase 2 or default>'
  const TERMS_CONTENT = '<HTML content from Phase 2 or default>'
  const TERMS_AGREEMENT_TEXT = '<value from Phase 2 or default>'
  const TERMS_BUTTON_TEXT = '<value from Phase 2 or default>'
  ```
- Display the heading, terms content (rendered as HTML via `dangerouslySetInnerHTML`), checkbox with agreement text, and confirm button
- The confirm button calls `acceptTerms('/')` from authService - this reads the query string from `window.location.search`, fetches the server terms page (with the same query string preserved) to get the anti-forgery token, then POSTs the acceptance back to the same URL with the flags from the query string in the body
- The confirm button is disabled until the checkbox is checked
- Display server errors inline if `acceptTerms()` throws
- Include a "Back to sign in" link to `/login`

**Login and Registration pages must catch `TermsRequiredError` (local auth path):**
Define `TermsRequiredError` from this workflow before merging the entry-linked `acceptTerms` asset; that asset contains the acceptance function, not the class.
- In the Login page's `loginLocal()` catch block: if `err instanceof TermsRequiredError`, navigate to `/terms`
- In the Registration page's `register()` catch block: if `err instanceof TermsRequiredError`, navigate to `/terms`

**No SPA code changes needed in `loginExternal` for the external auth path** - the header-template redirect (Phase 5.1.6) handles it transparently. The external user lands at `/terms?ReturnUrl=/&UseExternalSignInAsync=True&...` after the IdP round-trip; the SPA renders the Terms page; `acceptTerms()` uses the query string to POST back with the correct `UseExternalSignInAsync` / `IsFacebook` / `IsInternalAADUser` flags.

**How the server triggers terms (for reference):**
- **Local login flow**: Server redirects to `/Account/Login/TermsAndConditions` after auth - caught via `response.url.includes('TermsAndConditions')` in `loginLocal()`
- **Local registration flow**: Server redirects to `/TermsAndConditions?ReturnUrl=%2F` after registration - caught via `response.url.includes('TermsAndConditions')` in `register()`
- **External login flow**: Server redirects from `/Account/Login/ExternalLoginCallback` to `/Account/Login/TermsAndConditions?ReturnUrl=/&UseExternalSignInAsync=True&IsFacebook=False&IsInternalAADUser=False` - caught via header-template redirect

**`acceptTerms()` must be query-string-aware** (required when external providers are configured alongside terms):

```typescript
export async function acceptTerms(returnUrl?: string): Promise<void> {
  // Parse the flags from window.location.search - set by the server's redirect URL.
  // For local-auth users (no query string), defaults apply.
  const params = new URLSearchParams(window.location.search);
  const useExternalSignInAsync = params.get('UseExternalSignInAsync') || 'False';
  const isFacebook = params.get('IsFacebook') || 'False';
  const isInternalAADUser = params.get('IsInternalAADUser') || 'False';

  // Fetch the server terms page WITH the original query string preserved
  const serverTermsUrl = `/Account/Login/TermsAndConditions${window.location.search}`;
  const pageResponse = await fetch(serverTermsUrl, { credentials: 'same-origin', redirect: 'follow' });

  // ... extract anti-forgery token from rendered HTML ...

  // POST back to the same URL with body flags matching the query-string flags.
  // DO NOT hardcode UseExternalSignInAsync=False - external users need True.
  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', antiForgeryToken);
  body.set('IsTermsAndConditionsAccepted', 'true');
  body.set('UseExternalSignInAsync', useExternalSignInAsync);
  body.set('IsFacebook', isFacebook);
  body.set('IsInternalAADUser', isInternalAADUser);
  body.set('InvitationCode', '');
  // ... POST and handle response ...
}
```

Use the complete acceptance-service template listed directly in SKILL.md.

**Framework-specific implementation:**
- **React**: Create `src/pages/Terms.tsx` and add `<Route path="/terms" element={<Terms />} />` to the router

> **Content updates**: When the site creator wants to change the terms text, they update the constants in the Terms page component and redeploy. The content snippets in Dataverse (`Account/Signin/TermsAndConditionsCopy` etc.) must also be updated to match - the server-rendered terms page reads from snippets, and the SPA reads from the hardcoded constants. Both must stay in sync.

### Auth Service: TermsRequiredError and acceptTerms

Add to `authService.ts`:

```typescript
// Thrown when the server requires terms after login, registration or external confirmation.
// External confirmation supplies the query string from the server's terms form.
export class TermsRequiredError extends Error {
  readonly search: string;

  constructor(search = '') {
    super('Terms and conditions acceptance required.');
    this.name = 'TermsRequiredError';
    this.search = search;
  }
}
```

**Detection in `loginLocal()` and `register()`** - add before the redirect handling:

```typescript
// Check if the server redirected to terms (catches both URL patterns)
if (response.url.includes('TermsAndConditions')) {
  throw new TermsRequiredError();
}
```

**`acceptTerms()` function - query-string-aware:**

The function must read flags from `window.location.search` (set by the server's redirect URL for external auth) instead of hardcoding them. Without this, external users' POST to `/Account/Login/TermsAndConditions` sends `UseExternalSignInAsync=False` and the server won't complete their sign-in.

Template: `assets/terms-auth-service-termsrequirederror-and-acceptterms.ts.template` (listed directly in SKILL.md).

### React: Terms Page Component

Create `src/pages/Terms.tsx`. The terms content is hardcoded from the snippet values collected during skill setup:

```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { acceptTerms } from '../services/authService'

// Content from Power Pages content snippets - hardcoded during skill setup.
// Update these values and redeploy when the site creator changes the terms.
const TERMS_HEADING = 'Terms and Conditions'
const TERMS_CONTENT = `
  <p>By using this portal, you agree to the following terms of service.</p>
  <h3>1. Acceptance of Terms</h3>
  <p>By accessing and using this portal, you accept and agree to be bound by these terms.</p>
  <h3>2. Privacy & Data</h3>
  <p>We collect and process your personal data in accordance with our privacy policy.</p>
  <h3>3. Account Responsibility</h3>
  <p>You are responsible for maintaining the confidentiality of your account credentials.</p>
  <h3>4. Changes to Terms</h3>
  <p>We reserve the right to update these terms at any time.</p>
`
const TERMS_AGREEMENT_TEXT = 'I agree to these terms and conditions.'
const TERMS_BUTTON_TEXT = 'Confirm'

export default function Terms() {
  const [accepted, setAccepted] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | undefined>()

  useEffect(() => { document.title = `${TERMS_HEADING} - Site Name` }, [])

  function handleConfirm() {
    if (!accepted) return
    setIsSubmitting(true)
    setServerError(undefined)
    acceptTerms('/').catch(err => {
      setServerError(err instanceof Error ? err.message : 'Failed to accept terms.')
      setIsSubmitting(false)
    })
  }

  return (
    <section>
      <h1>{TERMS_HEADING}</h1>
      {serverError && <div role="alert">{serverError}</div>}
      <div dangerouslySetInnerHTML={{ __html: TERMS_CONTENT }} />
      <label>
        <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />
        {TERMS_AGREEMENT_TEXT}
      </label>
      <button onClick={handleConfirm} disabled={!accepted || isSubmitting}>
        {isSubmitting ? 'Confirming...' : TERMS_BUTTON_TEXT}
      </button>
      <p><Link to="/login">Back to sign in</Link></p>
    </section>
  )
}
```

Style the component to match the site's existing auth page design (card layout, CSS variables, etc.).

### Login and Registration: Catching TermsRequiredError

Both pages must catch `TermsRequiredError` in their submit handlers:

```typescript
// In Login.tsx
loginLocal(email, password, false, '/').catch(err => {
  if (err instanceof TermsRequiredError) {
    navigate('/terms')
    return
  }
  // ... existing error handling
})

// In Registration.tsx
register({ email, password, confirmPassword }, '/', invitationCode).catch(err => {
  if (err instanceof TermsRequiredError) {
    navigate('/terms')
    return
  }
  // ... existing error handling
})
```

### Content Snippets Used by the Server

The server-rendered terms page uses these snippets. Create the required one and optionally the others:

| Snippet | Required | Default |
|---------|----------|---------|
| `Account/Signin/TermsAndConditionsCopy` | **Yes** (feature disabled without it) | The terms HTML content |
| `Account/Signin/TermsAndConditionsHeading` | No | "Terms and Conditions" |
| `Account/Signin/TermsAndConditionsAgreementText` | No | "I agree to these terms and conditions." |
| `Account/Signin/TermsAndConditionsButtonText` | No | "Confirm" |

### Re-consent via TermsPublicationDate

The `TermsPublicationDate` site setting controls re-acceptance:
- **Not set**: users are prompted every login
- **Set to a date**: users who accepted after that date are not re-prompted. Bump the date to force everyone to re-accept when terms are updated.

The server stores acceptance on the contact record's `msdyn_portaltermsagreementdate` field.

---

## Site settings and snippets

**Terms and Conditions** - when terms are enabled:

> **Prerequisite**: The GDPR/Privacy Extensions solution (`msdynce_PortalPrivacyExtensions`) must be installed in the Dataverse environment. Without it, the server ignores `TermsAgreementEnabled` entirely. Remind the user of this requirement.

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/TermsAgreementEnabled" \
  --value "true" \
  --description "Require terms acceptance before accessing the site" \
  --type boolean
```

If the user provided a `TermsPublicationDate`:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/Registration/TermsPublicationDate" \
  --value "<ISO-date-from-user>" \
  --description "Users who accepted before this date will be re-prompted"
```

**Create the required content snippet** `Account/Signin/TermsAndConditionsCopy` in `.powerpages-site/content-snippets/`. This snippet MUST exist with non-empty content - without it, the server disables terms even if the setting is `true`. The snippet content should match the `TERMS_CONTENT` constant hardcoded in the SPA Terms page.

Check if the content snippet directory exists and create the snippet YAML file. The format follows the existing snippet pattern in `.powerpages-site/content-snippets/`. If a script exists for creating content snippets, use it. Otherwise, create the YAML file manually following the pattern of existing snippets.

Optionally create the other 3 snippets for the server-rendered terms page (used when the SPA isn't loaded, e.g., deep links):
- `Account/Signin/TermsAndConditionsHeading`
- `Account/Signin/TermsAndConditionsAgreementText`
- `Account/Signin/TermsAndConditionsButtonText`
