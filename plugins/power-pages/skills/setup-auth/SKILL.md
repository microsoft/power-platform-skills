---
description: Configure authentication, login, logout, and role-based authorization for Power Pages. Use this skill when you need to set up user login, implement authentication, configure Azure AD/Entra ID login, add logout functionality, manage user sessions, implement role-based access control, protect routes, or add conditional UI rendering based on user roles and permissions.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*), Bash(dotnet:*)
model: sonnet
---

# Setup Authentication & Authorization

This skill guides makers through implementing authentication (user login/logout) and authorization (role-based access control) for their Power Pages site. It uses Power Pages' built-in server-side authentication with Azure Active Directory and role-based UI conditional rendering.

## Reference Documentation

This skill uses modular reference files for detailed instructions:

| File | Purpose |
|------|---------|
| [authentication-reference.md](./authentication-reference.md) | Auth service code, login/logout flow, user info retrieval |
| [authorization-reference.md](./authorization-reference.md) | Role-based access control, conditional rendering, route protection |

## Memory Bank

This skill uses a **memory bank** (`memory-bank.md`) to persist context across sessions.

**Follow the instructions in `${CLAUDE_PLUGIN_ROOT}/shared/memory-bank.md`** for:
- Checking and reading the memory bank before starting
- Skipping completed steps and resuming progress
- Updating the memory bank after each major step

## Workflow Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Resume or Start Fresh                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Check memory bank for project context                                    │
│  • Verify /setup-webapi was completed                                       │
│  • Identify authentication requirements                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: Create Authentication Service                                      │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create auth service with login/logout methods                            │
│  • Implement user info retrieval from Power Pages portal object             │
│  • Handle authentication state management                                   │
│  📖 See: authentication-reference.md                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Create Authorization Utilities                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create role checking utilities                                           │
│  • Implement conditional rendering components                               │
│  • Create route protection (if applicable)                                  │
│  📖 See: authorization-reference.md                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Create Auth UI Components                                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Create login/logout button component                                     │
│  • Create user profile display component                                    │
│  • Integrate with site navigation                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: Implement Role-Based UI                                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Identify components needing role-based visibility                        │
│  • Apply conditional rendering based on user roles                          │
│  • Test with different user roles                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: Build and Upload                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Build the project                                                        │
│  • Upload to Power Pages                                                    │
│  • Verify authentication is working                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## STEP 1: Resume or Start Fresh

### Check Memory Bank First

**Before asking questions**, check if a memory bank exists:

1. If continuing from `/setup-webapi` in the same session, use the known project path
2. Otherwise, ask the user for the project path
3. Read `<PROJECT_PATH>/memory-bank.md` if it exists
4. Extract:
   - Project name and framework
   - Website ID and environment URL
   - Web roles configured (Anonymous Users, Authenticated Users)
   - Any previously configured authentication settings

If the memory bank shows `/setup-auth` steps already completed:

- Inform the user what was done
- Ask if they want to modify settings or add role-based features

### Check Prerequisites

**Verify Web API setup is complete:**

The authentication system depends on having:
- Site uploaded to Power Pages (required for `/_layout/tokenhtml` endpoint)
- Web roles created (Authenticated Users role must exist)

If `/setup-webapi` was not completed, suggest running it first:

> **Prerequisites Required**
>
> Authentication requires your site to be uploaded to Power Pages with Web API configured.
>
> Please run `/setup-webapi` first to complete the prerequisites.

### Gather Requirements

Use the `AskUserQuestion` tool to understand authentication needs:

| Question | Options |
|----------|---------|
| **Which features need authentication?** | Login/Logout only, User profile display, Role-based content, All of the above |
| **What roles need conditional UI?** | None, Admin only sections, Member-only content, Multiple role levels |

---

## STEP 2: Create Authentication Service

**📖 Detailed reference: [authentication-reference.md](./authentication-reference.md)**

### Quick Summary

Create an authentication service that handles:

1. **Login**: Server-side form submission to `/Account/Login/ExternalLogin`
2. **Logout**: Redirect to `/Account/Login/LogOff`
3. **User Info**: Retrieve from `window.Microsoft.Dynamic365.Portal.User`

### Key Points

- Power Pages uses **server-side authentication** (not client-side tokens)
- Anti-forgery token required from `/_layout/tokenhtml`
- User info is available in the global `window.Microsoft.Dynamic365.Portal` object
- Authentication state is session-based (cookies)

### Power Pages Portal Object

The portal object provides user information:

```typescript
window.Microsoft.Dynamic365.Portal.User = {
  userName: string;      // Login username
  firstName: string;     // First name
  lastName: string;      // Last name
  email: string;         // Email address
  contactId: string;     // Dataverse contact ID
  userRoles: string[];   // Array of role names
}
```

### Actions

1. Create `src/services/authService.ts` (copy from reference)
2. Create `src/types/powerPages.d.ts` for TypeScript declarations
3. Test that user info is accessible when logged in

---

## STEP 3: Create Authorization Utilities

**📖 Detailed reference: [authorization-reference.md](./authorization-reference.md)**

### Quick Summary

Create utilities for role-based access control:

1. **Role Checking**: Functions to check if user has specific roles
2. **Conditional Rendering**: Components that show/hide based on roles
3. **Route Protection**: Guards for protected routes (if using client-side routing)

### Key Points

- User roles are in `window.Microsoft.Dynamic365.Portal.User.userRoles`
- Roles are returned as an array of role names (strings)
- Common roles: "Administrators", "Authenticated Users", custom roles
- Role checks should be case-insensitive

### Actions

1. Create `src/utils/authorization.ts` with role checking functions
2. Create wrapper components for conditional rendering
3. Create route guard component (if using React Router, Vue Router, etc.)

---

## STEP 4: Create Auth UI Components

### Login/Logout Button Component

Create a component that:

- Shows "Sign In" button when not authenticated
- Shows user name and "Sign Out" button when authenticated
- Handles the login/logout flow

The component should:

1. Check authentication state on mount
2. Display appropriate UI based on state
3. Handle login button click (redirect to AAD)
4. Handle logout button click (redirect to logout endpoint)

### User Profile Component (Optional)

If user profile display is needed:

- Show user avatar/initials
- Display user name and email
- Show user roles (for debugging/admin purposes)

### Navigation Integration

Integrate auth components into the site header/navigation:

1. Read current navigation component
2. Add auth button to appropriate location
3. Ensure responsive design (mobile menu handling)

---

## STEP 5: Implement Role-Based UI

### Identify Components Needing Role-Based Access

Work with the user to identify:

- Admin-only sections (dashboard, settings)
- Member-only content (premium features, downloads)
- Role-specific navigation items
- Edit/delete buttons for content owners

### Apply Conditional Rendering

For each identified component:

1. Import authorization utilities
2. Wrap content with role-checking component
3. Provide fallback UI if needed (login prompt, access denied)

### Example Pattern

```tsx
// Show only to users with "Administrators" role
<RequireRole roles={["Administrators"]}>
  <AdminDashboard />
</RequireRole>

// Show only to authenticated users
<RequireAuth>
  <MemberContent />
</RequireAuth>

// Show different content based on role
{hasRole("Administrators") ? (
  <EditButton onClick={handleEdit} />
) : null}
```

---

## STEP 6: Build and Upload

### Build the Project

```powershell
cd <PROJECT_ROOT>
npm install  # if needed
npm run build
```

### Confirm Connected Account

**IMPORTANT**: Before uploading, you MUST confirm which account the user is connected with.

1. Run the following command to show the connected account:

```powershell
pac auth list
```

2. Display the connected account information to the user, including:
   - The active profile (marked with `*`)
   - The environment URL
   - The user email/account

3. Use the `AskUserQuestion` tool to confirm:

| Question | Options |
|----------|---------|
| **You are about to upload the site to the account shown above. Do you want to proceed?** | **Yes, upload to this account** - Proceed with the upload; **No, let me switch accounts** - User will run `pac auth create` to connect to a different account |

4. **Only proceed with upload after the user confirms.** If the user selects "No", guide them to authenticate to the correct account:

```powershell
# Create new authentication profile
pac auth create
```

Then run `pac auth list` again to verify and ask for confirmation again.

### Upload to Power Pages

```powershell
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

### Configure Site Settings

**IMPORTANT**: Configure the following site setting to ensure users are redirected to your app's home page after login (instead of Power Pages' default profile page):

| Setting | Value | Purpose |
|---------|-------|---------|
| `Authentication/Registration/ProfileRedirectEnabled` | `false` | Redirect to home page instead of profile page after login |

**📖 See [authentication-reference.md](./authentication-reference.md#site-settings)** for detailed instructions on how to configure this setting via Power Pages Admin Center, PAC CLI, or Dataverse Web API.

### Verify Authentication

1. Open the site in a browser
2. Click "Sign In" - should redirect to AAD login
3. After login, verify:
   - User name displays correctly
   - User roles are accessible
   - Role-based UI shows/hides correctly
4. Click "Sign Out" - should log out and redirect to home

### Test Role-Based Features

1. Log in with different users having different roles
2. Verify conditional UI works correctly:
   - Admin features visible only to admins
   - Member content visible only to members
   - Public content visible to all

### Troubleshooting

**Login button doesn't work:**
- Ensure site is uploaded to Power Pages (not local dev)
- Check browser console for errors
- Verify anti-forgery token endpoint is accessible

**User info not available:**
- User must be logged in for `window.Microsoft.Dynamic365.Portal.User` to be populated
- Check if user has a Contact record in Dataverse

**Roles not showing:**
- Verify user's Contact record is associated with web roles in Power Pages portal
- Check for typos in role names (case-insensitive comparison recommended)

---

## Cleanup Helper Files

**📖 See: [cleanup-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/cleanup-reference.md)**

Remove any temporary helper files created during this skill's execution. Verify authentication is working correctly before cleanup.

---

## Update Memory Bank

After completing this skill, update `memory-bank.md`:

```markdown
### /setup-auth
- [x] Authentication service created
- [x] PowerPages type declarations added
- [x] Authorization utilities created
- [x] Auth UI components created (login/logout button)
- [x] Role-based conditional rendering implemented
- [x] Project built successfully
- [x] Uploaded to Power Pages
- [x] Authentication verified working

## Created Resources

### Auth Files

| File | Purpose |
|------|---------|
| src/services/authService.ts | Authentication service |
| src/types/powerPages.d.ts | TypeScript declarations |
| src/utils/authorization.ts | Role checking utilities |
| src/components/AuthButton.tsx | Login/logout component |

### Role-Based Components

| Component | Roles Required | Purpose |
|-----------|----------------|---------|
| AdminDashboard | Administrators | Admin-only section |
| [ADD MORE AS IMPLEMENTED] |

## Current Status

**Last Action**: Authentication and authorization configured

**Next Step**: Test with different user accounts and roles
```
