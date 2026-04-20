---
name: create-webroles
description: >-
  Creates and configures web roles for a Power Pages code site. Web roles control access
  and permissions for site users, including authenticated and anonymous roles. Use when the
  user wants to create, add, set up, or manage web roles for their site.
user-invocable: true
allowed-tools: Read, Write, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Create Web Roles

Create web roles for a Power Pages code site. Web roles define the permissions and access levels for different types of site users.

## Core Principles

- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases — create the todo list upfront with all phases before starting any work.
- **Always use the UUID script**: Never generate UUIDs manually — always use `${CLAUDE_PLUGIN_ROOT}/scripts/generate-uuid.js` to produce valid UUID v4 values for each web role.
- **Preserve uniqueness constraints**: Only one role can have `anonymoususersrole: true` and only one can have `authenticatedusersrole: true`. Always check existing roles before setting these flags.

> **Prerequisite:** The site must be deployed at least once before web roles can be created, since deployment creates the `.powerpages-site` folder structure that stores web role definitions.

**Initial request:** $ARGUMENTS

---

## Workflow

1. **Phase 1: Verify Site Structure** → Check for `.powerpages-site/web-roles/` directory
2. **Phase 2: Discover Existing Roles** → Read current web role YAML files
3. **Phase 3: Determine New Roles** → Analyze the site and ask the user what roles are needed
4. **Phase 4: Create Web Role Files** → Generate YAML files with UUIDs from the Node script
5. **Phase 5: Verify Web Roles** → Validate all created files exist, have valid UUIDs, and flags are correct
6. **Phase 6: Review & Deploy** → Present summary and proceed to deployment

---

## Phase 1: Verify Site Structure

**Goal**: Confirm the `.powerpages-site/web-roles/` directory exists and is ready for web role files

**Actions**:

1. Locate the project root (`**/powerpages.config.json`) and check for `.powerpages-site/web-roles/`.

2. **If `.powerpages-site` does NOT exist:** Ask the user to deploy first via `AskUserQuestion` (options: "Yes, deploy now (Recommended)", "No, I'll do it later"). If yes, invoke `/deploy-site` then resume from Phase 2. If no, stop.

3. **If `.powerpages-site` exists but `web-roles/` does NOT:** Create it:

   ```powershell
   New-Item -ItemType Directory -Path "<PROJECT_ROOT>/.powerpages-site/web-roles" -Force
   ```

4. **If both exist:** Proceed to Phase 2.

**Output**: Confirmed `.powerpages-site/web-roles/` directory exists and is ready

---

## Phase 2: Discover Existing Roles

**Goal**: Identify all web roles already defined for the site

**Actions**:

1. Read all YAML files in the `.powerpages-site/web-roles/` directory. Each file represents one web role with this format:

   ```yaml
   anonymoususersrole: false
   authenticatedusersrole: false
   id: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444
   name: Administrators
   ```

2. Parse each file and compile a list of existing web roles (name, id, and flags).

3. Present the existing roles to the user:

   > "I found the following existing web roles in your site:"
   > - **Administrators** (id: `778fa3d0-...`, authenticated: false, anonymous: false)
   > - *(etc.)*

4. If no roles exist yet, inform the user:

   > "No web roles are currently defined for your site."

**Output**: Complete list of existing web roles with their names, IDs, and flags

---

## Phase 3: Determine New Roles

**Goal**: Decide which new web roles to create based on site needs and user input

**Actions**:

1. Based on the site's purpose and the existing roles, suggest appropriate web roles. Use `AskUserQuestion` to confirm with the user.

   Common web roles for Power Pages sites include:
   - **Administrators** — Full access to site management
   - **Authenticated Users** — Default role for logged-in users (set `authenticatedusersrole: true`)
   - **Anonymous Users** — Default role for non-logged-in visitors (set `anonymoususersrole: true`)
   - **Content Editors** — Users who can edit site content
   - **Moderators** — Users who can moderate community content
   - Custom roles based on business needs

2. Ask the user which roles they want to create:

   | Question | Options |
   |----------|---------|
   | Which web roles would you like to create for your site? You can select from suggestions or describe custom roles. | *(Provide relevant suggestions based on site context, existing roles, and business domain)* |

   CRITICAL: Do NOT suggest roles that already exist. Filter out any existing role names before presenting options.

3. Allow the user to specify custom role names as well.

**Output**: Confirmed list of new web roles to create

---

## Phase 4: Create Web Role Files

**Goal**: Generate properly formatted YAML files with valid UUIDs for each new web role

**Actions**:

For each new web role the user approved, create a YAML file in `.powerpages-site/web-roles/`.

### 4.1 Generate UUID

For each role, generate a UUID using the Node script. **NEVER generate UUIDs yourself — always use the script.**

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/generate-uuid.js"
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

**Output**: All new web role YAML files created

---

## Phase 5: Verify Web Roles

**Goal**: Validate that all created web role files exist, have valid format, and constraints are satisfied

**Actions**:

1. List all files in `.powerpages-site/web-roles/` and read each new file to confirm they were written correctly.

2. For each new web role file, verify:
   - The file exists at the expected path
   - The `id` field contains a valid UUID v4 format
   - The `name` field matches the expected role name
   - `anonymoususersrole` and `authenticatedusersrole` are valid booleans

3. Verify uniqueness constraints across ALL role files (existing + new):
   - At most one role has `anonymoususersrole: true`
   - At most one role has `authenticatedusersrole: true`
   - No duplicate `id` values exist across roles

4. If any file fails validation, fix the issue before proceeding.

**Output**: All web role files validated — correct format, valid UUIDs, no constraint violations

---

## Phase 6: Review & Deploy

**Goal**: Present a summary of created roles and offer deployment

**Actions**:

1. Record skill usage:

   > Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

   Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "CreateWebroles"`.

2. Present a summary of what was created:

   > "I've created the following new web roles:"
>
   > | Role Name | ID | Anonymous | Authenticated |
   > |-----------|-----|-----------|---------------|
   > | Content Editors | `a1b2c3d4-...` | false | false |
   > | *(etc.)* |

3. Then ask the user if they want to deploy the site to apply the new roles:

   | Question | Options |
   |----------|---------|
   | The new web roles have been created locally. To apply them in Power Pages, the site needs to be deployed. Would you like to deploy now? | Yes, deploy now (Recommended), No, I'll deploy later |

4. **If "Yes, deploy now"**: Tell the user to invoke the deploy skill:

   > "Please run `/deploy-site` to deploy your site and apply the new web roles."

5. **If "No, I'll deploy later"**: Acknowledge and remind them:

   > "No problem! Remember to deploy your site using `/deploy-site` when you're ready to apply the new web roles to your Power Pages environment."

**Output**: Summary presented and deployment offered

---

## Important Notes

### Key Decision Points (Wait for User)

1. After Phase 1: Confirm deployment if `.powerpages-site` is missing
2. After Phase 3: Confirm which roles to create
3. After Phase 6: Deploy or skip

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify site structure | Verifying site structure | Check for `.powerpages-site/web-roles/` directory, create if needed |
| Discover existing roles | Discovering existing roles | Read current web role YAML files and compile list of existing roles |
| Determine new roles | Determining new roles | Analyze site needs and ask user which roles to create |
| Create web role files | Creating web role files | Generate YAML files with UUIDs from the Node script for each new role |
| Verify web roles | Verifying web roles | Validate all files exist, have valid UUIDs, and uniqueness constraints are satisfied |
| Review and deploy | Reviewing and deploying | Present summary of created roles and offer deployment |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. This gives the user visibility into progress and keeps the workflow deterministic.

---

**Begin with Phase 1: Verify Site Structure**
