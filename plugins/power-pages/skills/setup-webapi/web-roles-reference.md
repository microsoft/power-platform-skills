# Web Roles Reference

Web roles define user groups with access levels. Create roles before table permissions.

## Built-in Web Roles

Power Pages creates these default web roles when a site is provisioned:

| Web Role | Description | Typical Use Case |
|----------|-------------|------------------|
| **Anonymous Users** | Unauthenticated site visitors | Public content, read-only product catalogs, FAQs |
| **Authenticated Users** | Any user who has signed in | Basic member features, form submissions |
| **Administrators** | Full administrative access | Site management, content editing |

### Role Hierarchy

Administrators → Authenticated Users (+ custom roles) → Anonymous Users

## Web Role YAML Files

Web roles are stored as YAML files in `.powerpages-site/web-roles/`.

### Folder Structure

```
<PROJECT_ROOT>/
├── .powerpages-site/
│   ├── web-roles/
│   │   ├── Anonymous-Users.webrole.yml
│   │   ├── Authenticated-Users.webrole.yml
│   │   ├── Administrators.webrole.yml
│   │   └── Customers.webrole.yml          # Custom role
│   └── ...
```

### YAML Format

```yaml
anonymoususersrole: false
authenticatedusersrole: false
id: <GENERATE_UUID>
name: <ROLE_NAME>
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | GUID | Yes | Unique identifier for this role |
| `name` | string | Yes | Display name of the role |
| `anonymoususersrole` | bool | Yes | `true` only for Anonymous Users role |
| `authenticatedusersrole` | bool | Yes | `true` only for Authenticated Users role |

### Built-in Role Examples

**Anonymous-Users.webrole.yml**
```yaml
anonymoususersrole: true
authenticatedusersrole: false
id: f0323770-7314-4f33-b904-21523abfbcb7
name: Anonymous Users
```

**Authenticated-Users.webrole.yml**
```yaml
anonymoususersrole: false
authenticatedusersrole: true
id: ecac9573-effb-4d63-9b27-15861f70f3de
name: Authenticated Users
```

**Administrators.webrole.yml**
```yaml
anonymoususersrole: false
authenticatedusersrole: false
id: 4e4ee36e-6535-4657-b62a-c4972d932558
name: Administrators
```

### Custom Role Examples

**Customers.webrole.yml**
```yaml
anonymoususersrole: false
authenticatedusersrole: false
id: 7a8b9c0d-1e2f-3456-7890-abcdef123456
name: Customers
```

**Premium-Members.webrole.yml**
```yaml
anonymoususersrole: false
authenticatedusersrole: false
id: 1b2c3d4e-5f6a-7890-bcde-f12345678901
name: Premium Members
```

### Generating Unique IDs

Each web role must have a unique `id` (UUID/GUID format).

**Claude Code MUST generate UUIDs by running a CLI command** - never write UUID values directly. Use the Bash tool to execute the appropriate command based on the user's shell/platform:

| Shell/Platform | Command |
|----------------|---------|
| **PowerShell** (Windows) | `[guid]::NewGuid().ToString()` |
| **Bash** (Linux) | `cat /proc/sys/kernel/random/uuid` |
| **Bash/Zsh** (macOS) | `uuidgen \| tr '[:upper:]' '[:lower:]'` |

## Creating Web Roles

### Step 1: Check Existing Roles

After the first upload, check what roles exist in `.powerpages-site/web-roles/`:

```powershell
Get-ChildItem -Path ".powerpages-site\web-roles" -Filter "*.webrole.yml"
```

### Step 2: Create Custom Role YAML

Create a new `.webrole.yml` file for each custom role needed:

```powershell
$roleName = "Customers"
$roleId = [guid]::NewGuid().ToString()

$content = @"
anonymoususersrole: false
authenticatedusersrole: false
id: $roleId
name: $roleName
"@

$fileName = "$roleName.webrole.yml"
$filePath = ".powerpages-site\web-roles\$fileName"
Set-Content -Path $filePath -Value $content -Encoding UTF8
Write-Host "Created: $filePath"
```

### Step 3: Upload to Apply

```powershell
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

## Role Selection by Feature

| Site Feature | Required Roles |
|--------------|----------------|
| Public landing page | Anonymous Users |
| Product/Service catalog | Anonymous Users |
| Contact form submission | Anonymous Users (create-only) |
| User dashboard | Authenticated Users |
| Order history | Customers (custom) |
| Admin panel | Administrators |
| Premium content | Premium Members (custom) |

## Common Role Patterns

### Pattern 1: Public Website
- Anonymous Users (default)
- Administrators (default)

### Pattern 2: Member Portal
- Anonymous Users
- Authenticated Users
- Administrators

### Pattern 3: Customer Portal
- Anonymous Users
- Customers (custom)
- Support Agents (custom)
- Administrators

### Pattern 4: Subscription Site
- Anonymous Users
- Free Members (custom)
- Premium Members (custom)
- Administrators

## Querying Existing Roles (API)

To query existing roles from Dataverse (for verification):

```powershell
$envUrl = (pac org who --json | ConvertFrom-Json).OrgUrl
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}
$baseUrl = "$envUrl/api/data/v9.2"

# List all web roles for the website (use mspp_webroles, not adx_webroles)
$websiteId = "<WEBSITE_ID>"
$roles = Invoke-RestMethod `
    -Uri "$baseUrl/mspp_webroles?`$filter=_mspp_websiteid_value eq $websiteId&`$select=mspp_webroleid,mspp_name" `
    -Headers $headers

$roles.value | ForEach-Object {
    Write-Host "Role: $($_.mspp_name) | ID: $($_.mspp_webroleid)"
}
```

## Validation Checklist

Before uploading:

- [ ] All YAML files have valid syntax
- [ ] Each file has a unique UUID for the `id` field
- [ ] File extension is `.yml` (not `.yaml`)
- [ ] `anonymoususersrole` and `authenticatedusersrole` are both `false` for custom roles
- [ ] Role names are descriptive and unique

## Next Steps

After creating web roles, create table permissions that reference these role IDs. See [table-permissions-reference.md](./table-permissions-reference.md).
