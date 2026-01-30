---
name: setting-up-authentication
description: Configures authentication (login/logout) and role-based authorization for Power Pages. Use when setting up user login, Azure AD/Entra ID auth, logout, role-based access control, route protection, or conditional UI based on roles.
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "TodoWrite", "AskUserQuestion", "Skill", "Task"]
model: opus
---

**📋 [Shared Instructions](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Read before starting.

# Setup Authentication & Authorization

**References:** [authentication](./references/authentication-reference.md) | [authorization](./references/authorization-reference.md)

## Workflow

1. **Check Prerequisites** → Verify `/setup-webapi` completed, site uploaded
2. **Create Auth Service** → Login/logout methods, user info retrieval
3. **Create Authorization Utils** → Role checking, conditional rendering
4. **Create Auth UI** → Login/logout button, user profile
5. **Implement Role-Based UI** → Wrap components with role checks
6. **Build and Upload** → Deploy and verify

---

## Step 1: Check Prerequisites

Read `memory-bank.md` for project context. Requires:
- Site uploaded to Power Pages (`/_layout/tokenhtml` endpoint needed)
- Web roles created (Authenticated Users must exist)

If `/setup-webapi` not completed, tell user to run it first.

Use `AskUserQuestion`:
- Which features? (Login/Logout only, User profile, Role-based content, All)
- Which roles need conditional UI? (None, Admin sections, Member content, Multiple)

---

## Step 2: Create Auth Service

See [authentication-reference.md](./references/authentication-reference.md).

Power Pages auth is **server-side** (session cookies, not client tokens):
- **Login**: POST to `/Account/Login/ExternalLogin` with anti-forgery token from `/_layout/tokenhtml`
- **Logout**: Redirect to `/Account/Login/LogOff`
- **User Info**: `window.Microsoft.Dynamic365.Portal.User` (userName, firstName, lastName, email, contactId, userRoles[])

Create:
1. `src/services/authService.ts`
2. `src/types/powerPages.d.ts`

---

## Step 3: Create Authorization Utils

See [authorization-reference.md](./references/authorization-reference.md).

Create `src/utils/authorization.ts`:
- Role checking functions (case-insensitive)
- Common roles: "Administrators", "Authenticated Users"

Create wrapper components:
- `RequireRole` - conditional rendering
- Route guard (if using client-side routing)

---

## Step 4: Create Auth UI

Create login/logout button component:
- Shows "Sign In" when unauthenticated
- Shows user name + "Sign Out" when authenticated

Integrate into site navigation. Optionally create user profile component.

---

## Step 5: Implement Role-Based UI

Identify components needing role-based visibility with user. Apply:

```tsx
<RequireRole roles={["Administrators"]}><AdminDashboard /></RequireRole>
<RequireAuth><MemberContent /></RequireAuth>
{hasRole("Administrators") && <EditButton />}
```

---

## Step 6: Build and Upload

```powershell
pac auth list  # Show available environments
```

**Ask user which environment** to upload to using `AskUserQuestion` (show org names from auth list). Switch if needed: `pac auth select --index <n>`.

**Create skill tracking setting, build, and upload:**
```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupAuth"
npm run build  # Always build before upload
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

See [authoring-tool-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/authoring-tool-reference.md) for helper function.

**Required site setting**: `Authentication/Registration/ProfileRedirectEnabled` = `false` (redirects to home instead of profile after login). See [authentication-reference.md](./references/authentication-reference.md#site-settings).

**Verify**: Sign in → check user name displays → check roles → sign out.

Update memory-bank.md. Cleanup per [cleanup-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/cleanup-reference.md).
