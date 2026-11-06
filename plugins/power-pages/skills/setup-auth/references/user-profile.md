# Optional user profile

#### 5.1.9 Create Profile Page (When INCLUDE_PROFILE_PAGE = true)

**Conditional on `INCLUDE_PROFILE_PAGE = true`** (Phase 2.1). Skip this entire phase otherwise.

Creates a `/user-profile` SPA page where signed-in users edit their contact record via the Power Pages Web API. Provider-agnostic - works for local + all external providers because it operates on the contact record after sign-in.

> **⚠ MANDATORY NAMING - do not deviate:**
>
> | Item | Required name | Wrong examples to AVOID |
> |---|---|---|
> | SPA route | `/user-profile` | ❌ `/profile` (server-reserved), `/my-profile`, `/account/profile` |
> | Page component file | `src/pages/UserProfile.tsx` | ❌ `Profile.tsx`, `MyProfile.tsx`, `UserProfilePage.tsx` |
> | Component export name | `UserProfile` (default export) | ❌ `Profile`, `ProfilePage` |
> | Service function - read | `getMyProfile(contactId)` | ❌ `getOwnContact`, `getProfile`, `fetchProfile` |
> | Service function - write | `updateMyProfile(contactId, payload)` | ❌ `patchOwnContact`, `updateProfile`, `saveProfile` |
> | Type - contact shape | `ProfileContact` | ❌ `Contact`, `UserContact` |
> | Type - patch payload | `ProfileUpdate` | ❌ `ContactUpdate`, `ProfilePatch` |
>
> Keep these names stable: routes, verification and profile templates use the same contract.
> `/profile` is reserved for the server; setting `ProfileRedirectEnabled=false` does not free it for SPA routing.

##### 5.1.9.a Extend authService with profile functions

Add to `src/services/authService.ts` (keep all related auth/profile logic in one place; reuse the existing `fetchAntiForgeryToken()` helper for the PATCH anti-forgery token).

**Use these EXACT names** - the executor MUST NOT invent shorter or differently-styled names like `patchOwnContact`, `getOwnContact`, `updateProfile`:

| Required name | Kind | Description |
|---|---|---|
| `ProfileContact` | exported interface | Typed contact shape with `contactid` + the 8 editable fields (firstname, lastname, mobilephone, address1_line1, address1_city, address1_stateorprovince, address1_postalcode, address1_country) all typed `string \| null`. **DO NOT include emailaddress1 or middlename** - email is displayed read-only from `useAuth().user.email` (no Web API roundtrip needed for it), and middlename is intentionally excluded from the simple form. |
| `ProfileUpdate` | exported type alias | `Partial<Omit<ProfileContact, 'contactid'>>` for the PATCH payload |
| `getMyProfile` | exported async function | Signature: `(contactId: string): Promise<ProfileContact>`. GETs `/_api/contacts({contactId})?$select=contactid,firstname,lastname,mobilephone,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country` (the `$select` value MUST exactly match the 9-entry list in Phase 8.1's `Webapi/contact/fields` site setting) with `credentials: 'same-origin'`. Throws on non-OK. Returns the parsed JSON. Dev-mode returns a mock object. |
| `updateMyProfile` | exported async function | Signature: `(contactId: string, payload: ProfileUpdate): Promise<void>`. PATCHes `/_api/contacts({contactId})` with body containing only DEFINED fields (skip `undefined` so partial updates don't blank-out unaffected columns - but DO send `null` for fields the user explicitly cleared). Headers: `Content-Type: application/json`, `If-Match: *`, `__RequestVerificationToken` from `fetchAntiForgeryToken()`. Throws on non-OK with parsed error message. Dev-mode is a no-op success. |
| `applyContactUpdateLocally` | exported function | Signature: `(payload: ProfileUpdate): void`. Mirrors the saved `firstname` / `lastname` from `payload` back into `window.Microsoft.Dynamic365.Portal.User` (mutating `firstName` / `lastName` properties in place - note the camelCase on the snapshot, lowercase on the payload). Returns early if `window` or `Portal.User` is unavailable. Only mirrors `firstname` and `lastname` - the other fields aren't used by the header. **Without this helper, the header keeps showing the old name after a save until the next full page reload - see the "header refresh after save" requirement in 5.1.9.b.** |

Use the profile-service template linked directly in SKILL.md without renaming its functions or signatures.

After a successful save, call `applyContactUpdateLocally(payload)` before `refresh()`.
Use the entry-linked React/Vue wrapper's `powerpages:auth-user-changed` notification so the page and header's separate hook instances both receive fresh snapshots.
Refreshing only the page's local state does not update AuthButton.
In Angular, share the root-provided AuthService and its Subject; do not redeclare it in component providers.
For Astro, dispatch the same notification and update mounted profile/header DOM subscribers, disposing listeners during navigation.

##### 5.1.9.b Create UserProfile.tsx

Create `src/pages/UserProfile.tsx` (filename mandatory, do NOT rename to `Profile.tsx`).

**Two sections - Account Details (read-only) at the top, then the edit form. Nothing else.**

### Account Details section (read-only, at top)

A simple display block showing exactly two pieces of info from `useAuth().user`:

| Label | Value source |
|---|---|
| Full name | `user.firstName` + ' ' + `user.lastName` (combined; show "-" if both empty) |
| Email | `user.email` |

**DO NOT** display contactId, userRoles, sign-in provider, username, last-login date, or any other field. The Account Details section's entire purpose is to remind the user which account they're signed in as - name and email suffice.

Rendering: a small card / heading "Account details" with two label-value rows. Use existing CSS variables. No edit affordance. No "edit email" button. No "edit account" link.

### Page logic

- Read `user`, `isAuthenticated`, `refresh` from `useAuth()`. If `!isAuthenticated`, redirect to `/login?returnUrl=/user-profile`.
- If `user.contactId` is empty or missing, show "Profile unavailable for this account. Your admin needs to set up the `RegistrationClaimsMapping` site setting for your auth provider so contacts get created with a valid ID." (handles the Entra workforce broken-claims-mapping edge case documented earlier in this skill)
- On mount, call `getMyProfile(user.contactId)` to fetch current values for the editable form. Show loading state.

### MANDATORY editable field set (exactly 8 fields)

The form MUST include exactly these 8 fields - no more, no less. Do NOT add email (it's read-only in Account Details). Do NOT add middlename. Do NOT add a "Change password" link. Do NOT add a "Sign out" button.

| Form label | Form field `name` attr / contact column | Type | Required on submit? |
|---|---|---|---|
| First name | `firstname` | text | No (all optional) |
| Last name | `lastname` | text | No |
| Mobile phone | `mobilephone` | tel | No |
| Address line 1 | `address1_line1` | text | No |
| City | `address1_city` | text | No |
| State / Province | `address1_stateorprovince` | text | No |
| Postal code | `address1_postalcode` | text | No |
| Country | `address1_country` | text | No |

All fields are optional. An empty string in the form is sent as `null` to the Web API (so users can clear values). The page layout groups Name fields (firstname/lastname), then Contact (mobile), then Address (all `address1_*` fields). Use a CSS grid with `grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))` for responsive 1-2 column layout.

### Things NOT to include on the profile page

The executor MUST NOT add any of these - they're either redundant with existing UI or out of scope:

- ❌ "Change password" link or button - password reset goes through the existing `/forgot-password` flow (link is on the Login page)
- ❌ "Sign out" button on the profile page - sign-out lives in the header AuthButton dropdown only
- ❌ Editable email field - email is displayed read-only in the Account Details section above
- ❌ Middle name field
- ❌ ContactId, userRoles, sign-in method, provider name, last-login timestamp, or any other account metadata
- ❌ Email caveat note (the note about LoginClaimsMapping overwriting email edits is no longer relevant since email isn't editable)
- ❌ Account deletion or "Close account" button - out of scope

### Logic details

- Validate-on-blur using the existing pattern from `Login.tsx` / `Registration.tsx` (`touched` state, `validateField`, `show()` helper)
- Field-level validation: mobile phone min 6 chars if non-empty. Other 7 fields have no format validation. All fields optional - empty strings allowed and sent as `null`.
- Submit calls `updateMyProfile(contactId, payload)`. On success, in this exact order:
  1. Set `successMessage` state to "Profile updated."
  2. Update the local `profile` snapshot (so the form's diff calculation on the next save is correct)
  3. **Call `applyContactUpdateLocally(payload)`** - mirrors the saved name fields back into `window.Microsoft.Dynamic365.Portal.User`. **This is REQUIRED for the header to repaint** - without it, the header keeps showing the pre-save name until the user navigates to a route that triggers a full page load.
  4. **Call `refresh()` from `useAuth()`** - re-reads `Portal.User` (now mutated) into React state with a spread (the useAuth update above), which triggers a re-render of `AuthButton`. Without the spread, this is a no-op because `setState` with an identical reference is skipped by React.

  On error: show server error inline.
- **Set the browser tab title** - add a `useEffect` near the top of the component (matching the convention used on `Login.tsx`, `Registration.tsx`, `ForgotPassword.tsx`, `ResetPassword.tsx`, `RedeemInvitation.tsx`, `ExternalLoginConfirmation.tsx`, `Terms.tsx`, etc.):

  ```tsx
  useEffect(() => { document.title = 'My Profile — <SITE_NAME>' }, [])
  ```

  Substitute `<SITE_NAME>` with the actual site display name discovered in Phase 1 (the same value used in the other auth pages - e.g., `Contoso Portal`). Format MUST match the existing pages exactly: `<Page Title> — <Site Name>` (Unicode U+2014, space on each side). Do NOT use `|`, `:`, or a hyphen.
- Use existing styles convention (CSS variables, card layout, max-width ~580)
- Use the profile-page template linked directly in SKILL.md

##### 5.1.9.c Evolve AuthButton to dropdown

Update `src/components/AuthButton.tsx`. **Make the dropdown shape the default for the authenticated state regardless of `INCLUDE_PROFILE_PAGE`** so the component is consistent and ready for future menu items:

- Anonymous state: unchanged - `<Link to="/login" className="btn-primary">Sign In</Link>`
- Authenticated state (NEW):
  - Trigger: `[Avatar] {displayName} ▾` - clickable
  - Menu (state-based, opened via `useState<boolean>`): renders when open
  - Menu items when `INCLUDE_PROFILE_PAGE = true`: "My Profile" (Link to `/user-profile`) + "Sign Out" (calls `logout('/')`)
  - Menu items when `INCLUDE_PROFILE_PAGE = false`: just "Sign Out"

**Web API for contact entity - conditional on `INCLUDE_PROFILE_PAGE = true`**

When the user opted into the profile page (Phase 2.1), enable Web API on the `contact` entity. These settings tell the Power Pages server which entity + fields are reachable via `/_api/{entity}` so the SPA's `getMyProfile` and `updateMyProfile` can read and write the user's contact record.

> **⚠ MANDATORY value for `Webapi/contact/fields`** - use this complete string verbatim. The executor MUST NOT trim it. All 9 entries must be present so the profile form can read AND write every editable field:
>
> ```
> contactid,firstname,lastname,mobilephone,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country
> ```
>
> This is `contactid` (for record identification) + the 8 editable fields listed in Phase 2.1 / Phase 5.1.9.b. **`emailaddress1` is NOT in this list** because email is displayed read-only in the Account Details section, sourced from `useAuth().user.email` - no Web API roundtrip needed for it. **`middlename` is NOT in this list** because it's intentionally excluded from the simple form. Skipping any entry from the list above causes the corresponding form input to silently fail with a 403 from the Web API.

```bash
# Enable Web API on the contact table
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Webapi/contact/enabled" \
  --value "true" \
  --description "Enable Web API access for contact table (profile page)" \
  --type boolean

# Allowed fields - USE THE EXACT VALUE BELOW (9 entries, all lowercase)
# Case-sensitive: PascalCase or Title Case produces 403 even if the column exists
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Webapi/contact/fields" \
  --value "contactid,firstname,lastname,mobilephone,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country" \
  --description "Fields allowed via Web API for profile page (read + write)"
```

> **Field name format**: all entries in the `fields` value MUST be lowercase Dataverse LogicalNames. The Web API does case-sensitive literal matching - `FirstName` or `Firstname` will produce a 403 Forbidden response from the server even though the column exists. The list above is correct.
>
> **Customizing the field list LATER**: if the user has custom contact columns they want to expose on the profile page (e.g., `cr123_jobtitle`), they can extend this `fields` value AND add the matching field to the `ProfileContact` interface + form in `UserProfile.tsx` AFTER the skill finishes. The skill itself MUST ship with exactly the 9 entries above - do not add or remove entries during scaffolding.

#### 8.1.x Create Table Permission for Contact (When INCLUDE_PROFILE_PAGE = true)

**Conditional on `INCLUDE_PROFILE_PAGE = true`.** Skip otherwise.

Enabling Web API for the contact table is NOT sufficient - the Power Pages server also requires a matching `adx_entitypermission` record granting the signed-in user read/write access. Without it, all `/_api/contacts(...)` calls return 403 even when the site settings allow the entity.

For the profile-page use case, **Self scope (`756150004`)** is the correct choice - it grants access only to the user's own contact record. The `create-table-permission.js` script validates this and rejects Contact scope for the contact table itself.

**Step 1 - Discover the Authenticated Users web role UUID.**

Phase 1.4 already inventoried web roles. Find the role with `authenticatedusersrole: true` in `.powerpages-site/web-roles/*.yml`. Typical filename: `Authenticated-Users.webrole.yml`. Extract its `id` field.

If no such role exists, warn the user:

> "No 'Authenticated Users' web role found on this site. Profile editing won't work for any user until a role with `authenticatedusersrole: true` exists and is assigned to users. Run `/create-webroles` to add one, then re-run this skill."

Skip the rest of this phase if no role found.

**Step 2 - Create the table permission.**

```bash
node "${PLUGIN_ROOT}/scripts/create-table-permission.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --permissionName "My Profile - Edit Own Contact" \
  --tableName "contact" \
  --webRoleIds "<authenticated-users-role-uuid>" \
  --scope "Self" \
  --read \
  --write
```

The script will create `.powerpages-site/table-permissions/My-Profile-Edit-Own-Contact.tablepermission.yml`:

```yaml
adx_entitypermission_webrole:
- <authenticated-users-role-uuid>
append: false
appendto: false
create: false
delete: false
entitylogicalname: contact
entityname: My Profile - Edit Own Contact
id: <generated-uuid>
read: true
scope: 756150004
write: true
```

Note: `create: false` + `delete: false` - users can read and update their own contact but NOT create new contacts or delete existing ones. This is the principle-of-least-privilege default for profile editing.

**Permission boundary verification**: with Self scope, even if a user crafts a malicious request like `PATCH /_api/contacts({someone-elses-contact-id})` from DevTools, the server returns 403. Self scope enforces row-level security based on the signed-in user's `contactid` from the session cookie.

### Auth service additions

Add to `src/services/authService.ts` (reuses the existing `fetchAntiForgeryToken()` helper for the PATCH anti-forgery token - no need for a separate Web API client):

Template: `assets/user-profile-auth-service-additions.ts.template` (listed directly in SKILL.md).

### React: UserProfile page

Create `src/pages/UserProfile.tsx`:

Template: `assets/user-profile-react-userprofile-page.tsx.template` (listed directly in SKILL.md).

> **Intentionally NOT included in this page** (the executor must NOT add these even if they seem like obvious enhancements):
> - **No editable email field** - email is read-only in Account Details. Across providers, email is often re-derived from claims on every login, so an SPA edit would be silently reverted and confuse the user.
> - **No middle-name field** - keeps the form simple. Makers can extend post-generation if needed.
> - **No Change Password / Reset Password link** - password management stays under `/forgot-password` for local accounts; surfacing it on the profile page muddles the UX for external-provider users who don't have a password at all.
> - **No Sign Out button** - sign-out lives in the header `AuthButton` dropdown; duplicating it here is redundant.
> - **No display of `contactId`, web roles, claims, or other metadata in Account Details** - those are debugging affordances, not user-facing info. Just full name + email.

### Updated AuthButton with dropdown

`src/components/AuthButton.tsx`:

Template: `assets/user-profile-updated-authbutton-with-dropdown.tsx.template` (listed directly in SKILL.md).

### Routing

In `src/App.tsx`:

```tsx
import UserProfile from './pages/UserProfile'
// ...
<Route path="/user-profile" element={<UserProfile />} />
```

### Permission boundary verification

To verify Self-scope is enforcing row-level security:
1. Sign in as user A → note their contactId (e.g., visible in `window.Microsoft.Dynamic365.Portal.User.contactId`)
2. In DevTools console, try to PATCH a different user's contact:
   ```javascript
   fetch('/_api/contacts(SOMEONE-ELSES-GUID)', {
     method: 'PATCH',
     headers: { 'Content-Type': 'application/json', 'If-Match': '*' },
     body: JSON.stringify({ firstname: 'Hacked' }),
     credentials: 'same-origin',
   }).then(r => console.log(r.status))
   ```
3. Expect 403. If you get 200, the table permission is misconfigured (wrong scope or wrong role assignment).
