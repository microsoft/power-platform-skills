---
name: create-webroles
description: >
  This skill should be used when the user asks to "create web roles", "add web roles",
  "set up web roles", "add roles", "create roles for my site", "manage web roles",
  "add authenticated role", "add anonymous role", or wants to create web roles for
  their Power Pages code site. Web roles control access and permissions for site users.
user-invocable: true
allowed-tools: ["Read", "Write", "Bash", "Grep", "Glob", "AskUserQuestion", "Task"]
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/create-webroles/scripts/validate-webroles.js"'
          timeout: 15
        - type: prompt
          prompt: >
            If web roles were being created in this session (via /power-pages:create-webroles),
            verify before allowing stop: 1) The .powerpages-site/web-roles/ directory was checked
            for existing roles, 2) New web role YAML files were created with valid UUIDs generated
            by the generate-uuid.js script, 3) The user was asked to deploy the site to apply the
            new roles. If any of these are incomplete, return { "ok": false, "reason": "<specific issues>" }.
            If no web role work happened or everything is complete, return { "ok": true }.
          timeout: 30
---

# Create Web Roles

Create web roles for a Power Pages code site. Web roles define the permissions and access levels for different types of site users.

> **Prerequisite:** The site must be deployed at least once before web roles can be created, since deployment creates the `.powerpages-site` folder structure that stores web role definitions.

## Workflow

1. **Verify Site Structure** → Check for `.powerpages-site/web-roles/` directory
2. **Discover Existing Roles** → Read current web role YAML files
3. **Determine New Roles** → Analyze the site and ask the user what roles are needed
4. **Create Web Role Files** → Generate YAML files with UUIDs from the Node script
5. **Review & Deploy** → Present summary and proceed to deployment

---

## Step 1: Verify Site Structure

Look for the `.powerpages-site/web-roles/` directory in the project root. Use `Glob` to search:

```text
**/.powerpages-site/web-roles
```

Also locate the project root by finding `powerpages.config.json`:

```text
**/powerpages.config.json
```

**If `.powerpages-site` folder does NOT exist:**

The site has not been deployed yet. The `.powerpages-site` folder is created automatically when the site is deployed for the first time using `pac pages upload-code-site`.

Tell the user:

> "The `.powerpages-site` folder was not found. This folder is created when the site is first deployed to Power Pages. I'll deploy your site first, and then we can create web roles."

Use `AskUserQuestion` to confirm:

| Question | Options |
|----------|---------|
| Your site needs to be deployed first so the `.powerpages-site` folder is created. Shall I deploy it now? | Yes, deploy now (Recommended), No, I'll do it later |

**If "Yes, deploy now"**: Invoke the `/power-pages:deploy-site` skill to deploy the site. Once deployment completes and `.powerpages-site` is created, resume this workflow from Step 2.

**If "No, I'll do it later"**: Stop here — the user must deploy first before web roles can be created.

**If `.powerpages-site` exists but `web-roles/` subdirectory does NOT exist:**

Create the `web-roles` directory:

```powershell
New-Item -ItemType Directory -Path "<PROJECT_ROOT>/.powerpages-site/web-roles" -Force
```

Proceed to Step 2.

**If both exist:** Proceed to Step 2.

---

## Step 2: Discover Existing Roles

Read all YAML files in the `.powerpages-site/web-roles/` directory. Each file represents one web role with this format:

```yaml
anonymoususersrole: false
authenticatedusersrole: false
id: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444
name: Administrators
```

Parse each file and compile a list of existing web roles (name, id, and flags).

Present the existing roles to the user:

> "I found the following existing web roles in your site:"
> - **Administrators** (id: `778fa3d0-...`, authenticated: false, anonymous: false)
> - *(etc.)*

If no roles exist yet, inform the user:

> "No web roles are currently defined for your site."

---

## Step 3: Determine New Roles

Based on the site's purpose and the existing roles, suggest appropriate web roles. Use `AskUserQuestion` to confirm with the user.

Common web roles for Power Pages sites include:
- **Administrators** — Full access to site management
- **Authenticated Users** — Default role for logged-in users (set `authenticatedusersrole: true`)
- **Anonymous Users** — Default role for non-logged-in visitors (set `anonymoususersrole: true`)
- **Content Editors** — Users who can edit site content
- **Moderators** — Users who can moderate community content
- Custom roles based on business needs

Ask the user which roles they want to create:

| Question | Options |
|----------|---------|
| Which web roles would you like to create for your site? You can select from suggestions or describe custom roles. | *(Provide relevant suggestions based on site context, existing roles, and business domain)* |

CRITICAL: Do NOT suggest roles that already exist. Filter out any existing role names before presenting options.

Allow the user to specify custom role names as well.

---

## Step 4: Create Web Role Files

For each new web role the user approved, create a YAML file in `.powerpages-site/web-roles/`.

### 4.1 Generate UUID

For each role, generate a UUID using the Node script. **NEVER generate UUIDs yourself — always use the script.**

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/create-webroles/scripts/generate-uuid.js"
```

### 4.2 Create the YAML File

The filename should be the role name in kebab-case with a `.yml` extension (e.g., `Administrators` → `administrators.yml`, `Content Editors` → `content-editors.yml`).

Write the file with this exact format (4 fields, no extra whitespace or comments):

```yaml
anonymoususersrole: <true if this is the anonymous users role, false otherwise>
authenticatedusersrole: <true if this is the authenticated users role, false otherwise>
id: <UUID from generate-uuid.js>
name: <Role Name>
```

**Rules:**
- Only ONE role can have `anonymoususersrole: true`
- Only ONE role can have `authenticatedusersrole: true`
- If an existing role already has one of these flags set to `true`, do not set it again on a new role
- Each role MUST have a unique UUID generated by the script — run the script once per role

### 4.3 Verify Files

After creating all files, list the contents of `.powerpages-site/web-roles/` and read each new file to confirm they were written correctly.

---

## Step 5: Review & Deploy

Present a summary of what was created:

> "I've created the following new web roles:"
> | Role Name | ID | Anonymous | Authenticated |
> |-----------|-----|-----------|---------------|
> | Content Editors | `a1b2c3d4-...` | false | false |
> | *(etc.)* |

Then ask the user if they want to deploy the site to apply the new roles:

| Question | Options |
|----------|---------|
| The new web roles have been created locally. To apply them in Power Pages, the site needs to be deployed. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll deploy later |

**If "Yes, deploy now"**: Tell the user to invoke the deploy skill:

> "Please run `/power-pages:deploy-site` to deploy your site and apply the new web roles."

**If "No, I'll deploy later"**: Acknowledge and remind them:

> "No problem! Remember to deploy your site using `/power-pages:deploy-site` when you're ready to apply the new web roles to your Power Pages environment."
