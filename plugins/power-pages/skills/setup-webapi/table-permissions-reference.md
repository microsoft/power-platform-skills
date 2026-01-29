# Table Permissions Reference

Table permissions control Web API data access. Create YAML files in `.powerpages-site/table-permissions/` and link to web roles.

## Permission Scopes

| Scope | Value | Description | Use Case |
|-------|-------|-------------|----------|
| **Global** | 756150000 | All records accessible | Public data (products, FAQs, testimonials) |
| **Contact** | 756150001 | Records linked to current contact | User-specific data |
| **Account** | 756150002 | Records linked to user's account | Organization data |
| **Parent** | 756150003 | Records linked via parent relationship | Hierarchical data |
| **Self** | 756150004 | Only records owned by current user | Private user data |

## CRUD Permissions

| Field | Description |
|-------|-------------|
| `read` | Can retrieve/query records |
| `create` | Can create new records |
| `write` | Can update existing records |
| `delete` | Can delete records |
| `append` | Can associate records to this entity |
| `appendto` | Can associate this entity to other records |

## Folder Structure

```
<PROJECT_ROOT>/
├── .powerpages-site/
│   ├── table-permissions/
│   │   ├── Product-Read-Permission.tablepermission.yml
│   │   ├── Contact-Self-Access.tablepermission.yml
│   │   └── ...
│   ├── web-roles/
│   │   ├── Anonymous-Users.webrole.yml
│   │   ├── Authenticated-Users.webrole.yml
│   │   └── ...
│   └── ...
```

## File Naming Convention

```
<Permission-Name>.tablepermission.yml
```

Example: `Product-Read-Permission.tablepermission.yml`

## YAML File Structure

```yaml
accountrelationship:
adx_entitypermission_webrole:
- f0323770-7314-4f33-b904-21523abfbcb7
append: false
appendto: false
contactrelationship:
create: false
delete: false
entitylogicalname: cr_product
entityname: Product Read Permission
id: b5d8334f-45fa-464c-ac1d-f7088325f697
parententitypermission:
parentrelationship:
read: true
scope: 756150000
write: false
```

**Important**:
- Fields are alphabetically sorted
- Field names do NOT include the `adx_` prefix (use `read` not `adx_read`)
- Exception: `adx_entitypermission_webrole` retains the full name (many-to-many relationship)

## YAML Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | GUID | Yes | Unique identifier for this permission |
| `entitylogicalname` | string | Yes | Dataverse table logical name |
| `entityname` | string | Yes | Display name for the permission |
| `scope` | int | Yes | Permission scope (see values above) |
| `read` | bool | No | Can retrieve/query records |
| `create` | bool | No | Can create new records |
| `write` | bool | No | Can update existing records |
| `delete` | bool | No | Can delete records |
| `append` | bool | No | Can associate records to this entity |
| `appendto` | bool | No | Can associate this entity to other records |
| `adx_entitypermission_webrole` | list | No | GUIDs of web roles with this permission |
| `parententitypermission` | GUID | No | Parent permission ID for hierarchical access |
| `parentrelationship` | string | No | Relationship name for parent scope |
| `accountrelationship` | string | No | Relationship name for account filtering |
| `contactrelationship` | string | No | Relationship name for contact filtering |

## Generating Unique IDs

**IMPORTANT**: Every table permission YAML file must have a unique `id` field (UUID/GUID format).

**Claude Code MUST generate UUIDs by running a CLI command** - never write UUID values directly. Use the Bash tool to execute the appropriate command based on the user's shell/platform:

| Shell/Platform | Command |
|----------------|---------|
| **PowerShell** (Windows) | `[guid]::NewGuid().ToString()` |
| **Bash** (Linux) | `cat /proc/sys/kernel/random/uuid` |
| **Bash/Zsh** (macOS) | `uuidgen \| tr '[:upper:]' '[:lower:]'` |

**Workflow:**
1. Run the UUID generation command via Bash tool
2. Capture the output
3. Use that value when writing the YAML file

## Getting Web Role GUIDs

Before creating table permissions, get the web role GUID from `.powerpages-site/web-roles/`. Each web role has a `.webrole.yml` file containing its `id`.

**Example web role file** (`.powerpages-site/web-roles/Anonymous-Users.webrole.yml`):
```yaml
anonymoususersrole: true
authenticatedusersrole: false
id: f0323770-7314-4f33-b904-21523abfbcb7
name: Anonymous Users
```

| Role | Description | Use Case |
|------|-------------|----------|
| **Anonymous Users** | Unauthenticated visitors | Public content access |
| **Authenticated Users** | Any logged-in user | Basic member features |
| **Administrators** | Full admin access | Site management |

## Using Table Name Mapping

**IMPORTANT**: Use the `$tableMap` from `/setup-dataverse` (stored in `memory-bank.md`) to get the correct table logical names:
- **Reused/Extended tables**: Use existing logical name (e.g., `contoso_items`)
- **New tables**: Use `{prefix}_tablename` pattern (e.g., `cr_product`)

## Common Permission Patterns

### Read-Only Public Data (Global Scope)

For tables like products, testimonials, FAQs that should be publicly readable.

**File**: `.powerpages-site/table-permissions/Product-Anonymous-Read.tablepermission.yml`
```yaml
adx_entitypermission_webrole:
- <ANONYMOUS_USERS_ROLE_ID>
append: false
appendto: false
create: false
delete: false
entitylogicalname: <TABLE_LOGICAL_NAME>
entityname: Product - Anonymous Read
id: <GENERATE_UUID>
parententitypermission:
read: true
scope: 756150000
write: false
```

### Create-Only (Form Submissions)

For contact forms where users can submit but not read others' submissions.

**File**: `.powerpages-site/table-permissions/Contact-Submission-Create.tablepermission.yml`
```yaml
adx_entitypermission_webrole:
- <ANONYMOUS_USERS_ROLE_ID>
append: false
appendto: false
create: true
delete: false
entitylogicalname: <TABLE_LOGICAL_NAME>
entityname: Contact Submission - Create Only
id: <GENERATE_UUID>
parententitypermission:
read: false
scope: 756150000
write: false
```

### User-Specific Data (Self Scope)

For data that users should only see their own records.

**File**: `.powerpages-site/table-permissions/User-Profile-Self-Access.tablepermission.yml`
```yaml
adx_entitypermission_webrole:
- <AUTHENTICATED_USERS_ROLE_ID>
append: false
appendto: false
create: true
delete: false
entitylogicalname: <TABLE_LOGICAL_NAME>
entityname: User Profile - Self Access
id: <GENERATE_UUID>
parententitypermission:
read: true
scope: 756150004
write: true
```

### Full CRUD Access

For authenticated users who need complete control (use with caution).

**File**: `.powerpages-site/table-permissions/Order-Full-Access.tablepermission.yml`
```yaml
adx_entitypermission_webrole:
- <AUTHENTICATED_USERS_ROLE_ID>
append: true
appendto: true
create: true
delete: true
entitylogicalname: <TABLE_LOGICAL_NAME>
entityname: Order - Full Access
id: <GENERATE_UUID>
parententitypermission:
read: true
scope: 756150001
write: true
```

## Parent-Child Table Permissions

When tables have relationships (e.g., Order → Order Items), use hierarchical permissions with the `parententitypermission` field and `Parent` scope.

**Creation Order:**
1. Create parent table permission first (e.g., for `{prefix}_order`)
2. Note the parent permission's `id` (GUID)
3. Create child permission with `parententitypermission` set to parent's ID
4. Set child's `scope` to `756150003` (Parent)
5. Set `parentrelationship` to the relationship name between child and parent tables

### Example: Parent Permission (Order)

**File**: `.powerpages-site/table-permissions/Order-User-Access.tablepermission.yml`
```yaml
adx_entitypermission_webrole:
- <AUTHENTICATED_USERS_ROLE_ID>
append: true
appendto: false
create: true
delete: false
entitylogicalname: {prefix}_order
entityname: Order - User Access
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
parententitypermission:
parentrelationship:
read: true
scope: 756150001
write: true
```

### Example: Child Permission (Order Items)

**File**: `.powerpages-site/table-permissions/Order-Item-Parent-Access.tablepermission.yml`
```yaml
adx_entitypermission_webrole:
- <AUTHENTICATED_USERS_ROLE_ID>
append: false
appendto: true
create: true
delete: true
entitylogicalname: {prefix}_orderitem
entityname: Order Item - Parent Access
id: b2c3d4e5-f6a7-8901-bcde-fa2345678901
parententitypermission: a1b2c3d4-e5f6-7890-abcd-ef1234567890
parentrelationship: {prefix}_order_orderitems
read: true
scope: 756150003
write: true
```

Users can only access order items that belong to orders they have access to.

## Validation Checklist

Before uploading:

- [ ] All YAML files have valid syntax
- [ ] Each file has a unique UUID for the `id` field (generated via CLI command)
- [ ] Fields are alphabetically sorted
- [ ] File extensions are `.yml` (not `.yaml`)
- [ ] Field names do NOT include `adx_` prefix (except `adx_entitypermission_webrole`)
- [ ] Boolean values are unquoted (`true` not `"true"`)
- [ ] All GUIDs are valid UUID format (lowercase with hyphens)
- [ ] Web role GUIDs exist in `.powerpages-site/web-roles/` folder

## Security Best Practices

1. **Least Privilege**: Grant only the minimum permissions needed
2. **Avoid Global Scope for Write**: Use Contact/Account/Self scopes for write operations
3. **Separate Read and Write**: Create different permissions for reading vs. modifying data
4. **Audit Regularly**: Review permissions periodically
5. **Test as Anonymous**: Verify anonymous users can only access intended data

## Permission Decision Matrix

| Data Type | Recommended Scope | Read | Create | Write | Delete |
|-----------|-------------------|------|--------|-------|--------|
| Public content (products, FAQs) | Global | Yes | No | No | No |
| Form submissions | Global | No | Yes | No | No |
| User profiles | Self | Yes | Yes | Yes | No |
| User's own orders | Contact | Yes | Yes | Yes | No |
| Admin data | N/A (via app) | No | No | No | No |
