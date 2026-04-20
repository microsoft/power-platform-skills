---
name: setup-auth
description: >-
  Sets up authentication (login/logout via Microsoft Entra ID) and role-based authorization
  for a Power Pages code site. Configures identity providers, protected routes, and access
  control. Use when the user wants to add login, configure Entra ID, enable authentication,
  or add role-based access to their site.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, Skill
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Set Up Authentication & Authorization

Configure authentication (login/logout via Microsoft Entra ID) and role-based authorization for a Power Pages code site. This skill creates an auth service, type declarations, authorization utilities, auth UI components, and role-based access control patterns appropriate to the site's framework.

## Core Principles

- **Client-side auth is UX only** — Power Pages authentication is server-side (session cookies). Client-side role checks control what users see, not what they can access. Server-side table permissions enforce actual security.
- **Framework-appropriate patterns** — Every auth artifact (hooks, composables, services, directives, guards) must match the detected framework's idioms and conventions.
- **Development parity** — Include mock data for local development so developers can test auth flows and role-based UI without deploying to Power Pages.

**Initial request:** $ARGUMENTS

> **Prerequisites:**
>
> - An existing Power Pages code site created via `/create-site`
> - The site must be deployed at least once (`.powerpages-site` folder must exist)
> - Web roles must be created via `/create-webroles`

## Workflow

1. **Phase 1: Check Prerequisites** — Verify site exists, detect framework, check web roles
2. **Phase 2: Plan** — Gather auth requirements and present plan for approval
3. **Phase 3: Create Auth Service** — Auth service with login/logout and type declarations
4. **Phase 4: Create Authorization Utils** — Role-checking functions and wrapper components
5. **Phase 5: Create Auth UI** — Login/logout button integrated into navigation
6. **Phase 6: Implement Role-Based UI** — Apply role-based patterns to site components
7. **Phase 7: Verify Auth Setup** — Validate all auth files exist, build succeeds, auth UI renders
8. **Phase 8: Review & Deploy** — Summary and deployment prompt

---

## Phase 1: Check Prerequisites

**Goal:** Confirm the project exists, identify the framework, verify deployment status and web roles, and check for existing auth code.

### Actions

#### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories:

```text
**/powerpages.config.json
```

**If not found**: Tell the user to create a site first with `/create-site`.

#### 1.2 Detect Framework

Read `package.json` to determine the framework (React, Vue, Angular, or Astro). See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework detection mapping.

#### 1.3 Check Deployment Status

Look for the `.powerpages-site` folder:

```text
**/.powerpages-site
```

**If not found**: Tell the user the site must be deployed first:

> "The `.powerpages-site` folder was not found. The site needs to be deployed at least once before authentication can be configured."

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Your site needs to be deployed first. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll do it later |

**If "Yes, deploy now"**: Invoke `/deploy-site`, then resume.

**If "No"**: Stop — the site must be deployed first.

#### 1.4 Check Web Roles

Look for web role YAML files in `.powerpages-site/web-roles/`:

```text
**/.powerpages-site/web-roles/*.yml
```

Read each file and compile a list of existing web roles (name, id, flags).

**If no web roles exist**: Warn the user that web roles are needed for authorization. Ask if they want to create them first:

| Question | Options |
|----------|---------|
| No web roles were found. Web roles are required for role-based authorization. Would you like to create them now? | Yes, create web roles first (Recommended), Skip — I'll add roles later |

**If "Yes"**: Invoke `/create-webroles`, then resume.

**If "Skip"**: Continue — auth service and login/logout will still work, but role-based authorization will need roles created later.

#### 1.5 Check for Existing Auth Code

Search for existing auth files to avoid duplicating work:

- `src/services/authService.ts` or `src/services/authService.js`
- `src/types/powerPages.d.ts`
- `src/utils/authorization.ts` or `src/utils/authorization.js`
- Auth components (e.g., `AuthButton.tsx`, `AuthButton.vue`)

If auth files already exist, present them to the user and ask whether to overwrite or skip.

### Output

- Project root path confirmed
- Framework identified (React, Vue, Angular, or Astro)
- Deployment status verified
- Web roles inventory compiled
- Existing auth code conflicts identified (if any)

---

## Phase 2: Plan

**Goal:** Gather authentication requirements from the user and present the implementation plan for approval.

### Actions

#### 2.1 Gather Requirements

Use `AskUserQuestion` to determine the scope:

| Question | Options |
|----------|---------|
| Which authentication features do you need? | Login & Logout + Role-based access control (Recommended), Login & Logout only, Role-based access control only (auth service already exists) |

If web roles were found in Phase 1.4, also ask:

| Question | Options |
|----------|---------|
| Which web roles should have access to protected areas of the site? | *(List discovered web role names as options)* |

#### 2.2 Present Plan for Approval

Present the implementation plan inline:

- Which files will be created (auth service, types, authorization utils, components)
- How the auth UI will be integrated into the site's navigation
- Which routes/components will be protected and with which roles
- The site setting that needs to be configured (`Authentication/Registration/ProfileRedirectEnabled = false`)

Use `AskUserQuestion` to get approval:

| Question | Options |
|----------|---------|
| Here is the implementation plan for authentication and authorization. Would you like to proceed? | Approve and proceed (Recommended), I'd like to make changes |

**If "Approve and proceed"**: Continue to Phase 3.

**If "I'd like to make changes"**: Ask the user what they want to change, revise the plan, and present it again for approval.

### Output

- Authentication scope confirmed (login/logout, role-based access, or both)
- Target web roles selected
- Implementation plan approved by user

---

## Phase 3: Create Auth Service

**Goal:** Create the authentication service, type declarations, and framework-specific auth hook/composable with local development mock support.

Reference: `${CLAUDE_PLUGIN_ROOT}/skills/setup-auth/references/authentication-reference.md`

### Actions

#### 3.1 Create Type Declarations

Create `src/types/powerPages.d.ts` with type definitions for the Power Pages portal object and user:

- `PowerPagesUser` interface — `userName`, `firstName`, `lastName`, `email`, `contactId`, `userRoles[]`
- `PowerPagesPortal` interface — `User`, `version`, `type`, `id`, `geo`, `tenant`, etc.
- Global `Window` interface extension for `Microsoft.Dynamic365.Portal`

#### 3.2 Create Auth Service

Create the auth service file based on the detected framework:

**All frameworks**: Create `src/services/authService.ts` with these functions:

- `getCurrentUser()` — reads from `window.Microsoft.Dynamic365.Portal.User`
- `isAuthenticated()` — checks if user exists and has `userName`
- `getTenantId()` — reads from portal config (`window.Microsoft.Dynamic365.Portal.tenant`)
- `fetchAntiForgeryToken()` — fetches from `/_layout/tokenhtml` and parses HTML response
- `login(returnUrl?)` — creates a form POST to `/Account/Login/ExternalLogin` with:
  - Anti-forgery token from `/_layout/tokenhtml`
  - Provider URL: `https://login.windows.net/{tenantId}/`
  - Return URL (defaults to current page)
- `logout(returnUrl?)` — redirects to `/Account/Login/LogOff`
- `getUserDisplayName()` — prefers full name, falls back to userName
- `getUserInitials()` — for avatar display

**CRITICAL**: Power Pages authentication is **server-side** (session cookies). The login flow posts a form to the server which redirects to Entra ID. There is no client-side token management. The `fetchAntiForgeryToken()` call gets a CSRF token for the form POST, not a bearer token.

#### 3.3 Create Framework-Specific Auth Hook/Composable

Based on the detected framework:

- **React**: Create `src/hooks/useAuth.ts` — custom hook returning `{ user, isAuthenticated, isLoading, displayName, initials, login, logout, refresh }`
- **Vue**: Create `src/composables/useAuth.ts` — composable using `ref`, `computed`, `onMounted` returning reactive auth state
- **Angular**: Create `src/app/services/auth.service.ts` — injectable service with `BehaviorSubject` for user state
- **Astro**: Create `src/services/authService.ts` only (no framework-specific wrapper needed — use the service directly in components)

#### 3.4 Add Mock Data for Local Development

Auth only works when served from Power Pages (not during local `npm run dev`). Add a development mock pattern in the auth service:

```typescript
// In development (localhost), return mock user data for testing
const isDevelopment = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
```

The mock should return a fake user with configurable roles so developers can test role-based UI locally.

### Output

- `src/types/powerPages.d.ts` created with Power Pages type definitions
- `src/services/authService.ts` created with login/logout functions
- Framework-specific auth hook/composable created
- Local development mock data included

---

## Phase 4: Create Authorization Utils

**Goal:** Create role-checking utilities and framework-specific authorization components (guards, directives, wrapper components).

Reference: `${CLAUDE_PLUGIN_ROOT}/skills/setup-auth/references/authorization-reference.md`

### Actions

#### 4.1 Create Core Authorization Utilities

Create `src/utils/authorization.ts` with:

- `getUserRoles()` — returns array of role names from current user
- `hasRole(roleName)` — case-insensitive single role check
- `hasAnyRole(roleNames)` — OR check across multiple roles
- `hasAllRoles(roleNames)` — AND check across multiple roles
- `isAuthenticated()` — re-exports from auth service
- `isAdmin()` — checks for "Administrators" role
- `hasElevatedAccess(additionalRoles)` — checks admin or specified roles

#### 4.2 Create Framework-Specific Authorization Components

Based on the detected framework:

**React:**

- `src/components/RequireAuth.tsx` — renders children only for authenticated users, optional login prompt fallback
- `src/components/RequireRole.tsx` — renders children only for users with specified roles, supports `requireAll` mode
- `src/hooks/useAuthorization.ts` — hook returning `{ roles, hasRole, hasAnyRole, hasAllRoles, isAuthenticated, isAdmin }`

**Vue:**

- `src/composables/useAuthorization.ts` — composable with computed roles and role-checking functions
- `src/directives/vRole.ts` — `v-role` directive for declarative role-based visibility

**Angular:**

- `src/app/guards/auth.guard.ts` — `CanActivateFn` with route data for required roles
- `src/app/directives/has-role.directive.ts` — structural directive `*appHasRole="'RoleName'"`

**Astro:**

- `src/utils/authorization.ts` only (use directly in component scripts)

#### 4.3 Security Reminder

Add a comment at the top of the authorization utilities:

```typescript
// IMPORTANT: Client-side authorization is for UX only, not security.
// Server-side table permissions enforce actual access control.
// Always configure table permissions via /integrate-webapi.
```

### Output

- `src/utils/authorization.ts` created with role-checking functions
- Framework-specific authorization components created (guards, directives, or wrapper components)
- Security reminder comments included

---

## Phase 5: Create Auth UI

**Goal:** Create the login/logout button component and integrate it into the site's navigation.

### Actions

#### 5.1 Create Auth Button Component

Based on the detected framework, create a login/logout button component:

- **React**: `src/components/AuthButton.tsx` + `src/components/AuthButton.css`
- **Vue**: `src/components/AuthButton.vue`
- **Angular**: `src/app/components/auth-button/auth-button.component.ts` + template + styles
- **Astro**: `src/components/AuthButton.astro`

The component should:

- Show a "Sign In" button when the user is not authenticated
- Show the user's display name, avatar (initials-based), and a "Sign Out" button when authenticated
- Include a loading state while checking auth status
- Be styled to match the site's existing design (read existing CSS variables/theme)

#### 5.2 Integrate into Navigation

Find the site's navigation component and integrate the auth button:

1. Search for the nav/header component in the site's source code
2. Import the AuthButton component
3. Add it to the navigation bar (typically in the top-right area)

**Do NOT replace the existing navigation** — add the auth button alongside existing nav items.

#### 5.3 Git Commit

Stage and commit the auth files:

```powershell
git add -A
git commit -m "Add authentication service and auth UI component"
```

### Output

- Auth button component created for the detected framework
- Auth button integrated into the site's navigation
- Changes committed to git

---

## Phase 6: Implement Role-Based UI

**Goal:** Identify protected content areas and apply role-based authorization patterns to the site's components.

### Actions

#### 6.1 Identify Protected Content

Analyze the site's components to find content that should be role-gated:

- Admin-only sections (dashboards, settings)
- Authenticated-only content (profile, data views)
- Role-specific features (edit buttons, create forms)

Present findings to the user and confirm which areas to protect.

#### 6.2 Apply Authorization Patterns

Based on the user's choices, wrap the appropriate components:

**React example:**

```tsx
<RequireAuth fallback={<p>Please sign in to view this content.</p>}>
  <Dashboard />
</RequireAuth>

<RequireRole roles={['Administrators']} fallback={<p>Access denied.</p>}>
  <AdminPanel />
</RequireRole>
```

**Vue example:**

```vue
<div v-role="'Administrators'">
  <AdminPanel />
</div>
```

**Angular example:**

```typescript
{ path: 'admin', component: AdminComponent, canActivate: [authGuard, roleGuard], data: { roles: ['Administrators'] } }
```

#### 6.3 Git Commit

Stage and commit:

```powershell
git add -A
git commit -m "Add role-based access control to site components"
```

### Output

- Protected content areas identified and confirmed with user
- Role-based authorization patterns applied to components
- Changes committed to git

---

## Phase 7: Verify Auth Setup

**Goal:** Validate that all auth files exist, the project builds, and the auth UI renders correctly.

### Actions

#### 7.1 Verify File Inventory

Confirm the following files were created:

- `src/types/powerPages.d.ts` — Power Pages type declarations
- `src/services/authService.ts` — Auth service with login/logout functions
- Framework-specific auth hook/composable (e.g., `src/hooks/useAuth.ts` for React)
- `src/utils/authorization.ts` — Role-checking utilities
- Framework-specific authorization components (e.g., `RequireAuth.tsx`, `RequireRole.tsx` for React)
- Auth button component (e.g., `src/components/AuthButton.tsx` for React)

Read each file and verify it contains the expected exports and functions:

- Auth service: `login`, `logout`, `getCurrentUser`, `isAuthenticated`, `fetchAntiForgeryToken`
- Authorization utils: `hasRole`, `hasAnyRole`, `hasAllRoles`, `getUserRoles`

#### 7.2 Verify Build

Run the project build to catch any import errors, type errors, or missing dependencies:

```powershell
npm run build
```

If the build fails, fix the issues before proceeding.

#### 7.3 Verify Auth UI Renders

Start the dev server and verify the auth button appears in the navigation:

```powershell
npm run dev
```

Use Playwright to navigate to the site and take a snapshot to confirm the auth button is visible:

- Navigate to `http://localhost:<port>`
- Take a browser snapshot
- Verify the auth button (Sign In / mock user) appears in the navigation area

If the auth button is not visible or the page has rendering errors, fix the issues.

### Output

- All auth files verified (present and contain expected exports)
- Project builds successfully
- Auth UI renders correctly in the browser

---

## Phase 8: Review & Deploy

**Goal:** Create required site settings, present a summary of all work, and prompt for deployment.

### Actions

#### 8.1 Create Site Setting

The site needs the `Authentication/Registration/ProfileRedirectEnabled` setting set to `false` to prevent Power Pages from redirecting users to a profile page after login (which doesn't exist in code sites).

Check if `.powerpages-site/site-settings/` exists. If it does, create the site setting file:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/generate-uuid.js"
```

Create `.powerpages-site/site-settings/authentication-registration-profileredirectenabled.yml`:

```yaml
id: <UUID from generate-uuid.js>
name: Authentication/Registration/ProfileRedirectEnabled
value: false
```

#### 8.2 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "SetupAuth"`.

#### 8.3 Present Summary

Present a summary of everything created:

| Component | File(s) | Status |
|-----------|---------|--------|
| Type Declarations | `src/types/powerPages.d.ts` | Created |
| Auth Service | `src/services/authService.ts` | Created |
| Auth Hook/Composable | `src/hooks/useAuth.ts` (or framework equivalent) | Created |
| Authorization Utils | `src/utils/authorization.ts` | Created |
| Auth Components | `RequireAuth`, `RequireRole` (or framework equivalent) | Created |
| Auth Button | `src/components/AuthButton.tsx` (or framework equivalent) | Created |
| Site Setting | `ProfileRedirectEnabled = false` | Created |

#### 8.4 Ask to Deploy

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Authentication and authorization are configured. To make login work, the site needs to be deployed. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll deploy later |

**If "Yes, deploy now"**: Invoke `/deploy-site`.

**If "No"**: Remind the user:

> "Remember to deploy your site using `/deploy-site` when you're ready. Authentication will not work until the site is deployed with the new site settings."

#### 8.5 Post-Deploy Notes

After deployment (or if skipped), remind the user:

- **Test on deployed site**: Auth only works on the deployed Power Pages site, not on `localhost`
- **Entra ID configuration**: The site's identity provider must be configured in the Power Pages admin center to use Microsoft Entra ID
- **Assign web roles**: Users must be assigned appropriate web roles in the Power Pages admin center
- **Table permissions**: Client-side auth checks are for UX only — configure server-side table permissions via `/integrate-webapi` for actual data security
- **Local development**: The auth service includes mock data for testing on localhost — remove or disable before production

### Output

- `ProfileRedirectEnabled` site setting created
- Full summary presented to user
- Deployment prompted (or skipped with reminder)
- Post-deploy guidance provided

---

## Important Notes

### Progress Tracking

Use `TaskCreate` at the start to track each phase:

| Task | Description |
|------|-------------|
| Phase 1 | Check Prerequisites — verify site, framework, deployment, web roles |
| Phase 2 | Plan — gather requirements and get user approval |
| Phase 3 | Create Auth Service — auth service, types, framework hook/composable |
| Phase 4 | Create Authorization Utils — role-checking functions and components |
| Phase 5 | Create Auth UI — AuthButton component and navigation integration |
| Phase 6 | Implement Role-Based UI — apply authorization patterns to components |
| Phase 7 | Verify Auth Setup — validate files exist, build succeeds, auth UI renders |
| Phase 8 | Review & Deploy — site setting, summary, deployment prompt |

Update each task with `TaskUpdate` as phases are completed.

### Key Decision Points

- **Phase 1.3**: Deploy now or stop? (site must be deployed before auth setup)
- **Phase 1.4**: Create web roles now or skip? (roles needed for authorization)
- **Phase 1.5**: Overwrite or skip existing auth files?
- **Phase 2.1**: Which auth features to include? (login/logout, role-based, or both)
- **Phase 2.2**: Approve plan or request changes?
- **Phase 6.1**: Which content areas to protect with role-based access?
- **Phase 8.3**: Deploy now or later?

---

**Begin with Phase 1: Check Prerequisites**
