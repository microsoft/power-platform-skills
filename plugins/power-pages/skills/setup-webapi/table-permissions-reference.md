# Table Permissions Reference

This document describes how to create table permissions (entity permissions) for Power Pages Web API access.

## Understanding Table Permissions

Table permissions control which users can access data through the Web API. These must be created in Dataverse and linked to web roles.

### Permission Scopes

| Scope | Value | Description | Use Case |
|-------|-------|-------------|----------|
| **Global** | 756150000 | All records accessible | Public data (products, FAQs, testimonials) |
| **Contact** | 756150001 | Records linked to current contact | User-specific data |
| **Account** | 756150002 | Records linked to user's account | Organization data |
| **Parent** | 756150003 | Records linked via parent relationship | Hierarchical data |
| **Self** | 756150004 | Only records owned by current user | Private user data |

### CRUD Permissions

| Permission | Description |
|------------|-------------|
| `adx_read` | Can retrieve/query records |
| `adx_create` | Can create new records |
| `adx_write` | Can update existing records |
| `adx_delete` | Can delete records |
| `adx_append` | Can associate records to this entity |
| `adx_appendto` | Can associate this entity to other records |

## Prerequisites

Before creating table permissions, ensure you have:

1. Environment URL from `pac org who`
2. Website ID from `pac pages list --verbose`
3. Azure CLI authenticated (`az login`)

## PowerShell Setup

```powershell
# Get environment URL and access token
$envUrl = (pac org who --json | ConvertFrom-Json).OrgUrl
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
}

$baseUrl = "$envUrl/api/data/v9.2"

# Set your Website ID (from pac pages list)
$websiteId = "<WEBSITE_ID_FROM_MEMORY_BANK>"
```

## Create Table Permission Function

```powershell
function New-TablePermission {
    param(
        [string]$Name,
        [string]$TableLogicalName,
        [string]$WebsiteId,
        [int]$Scope = 756150000,  # Global
        [bool]$Read = $true,
        [bool]$Create = $false,
        [bool]$Write = $false,
        [bool]$Delete = $false,
        [bool]$Append = $false,
        [bool]$AppendTo = $false
    )

    # Generate unique ID for the permission
    $permissionId = [guid]::NewGuid().ToString()

    $permission = @{
        "adx_entitypermissionid" = $permissionId
        "adx_entityname" = $TableLogicalName
        "adx_entitylogicalname" = $TableLogicalName
        "adx_scope" = $Scope
        "adx_read" = $Read
        "adx_create" = $Create
        "adx_write" = $Write
        "adx_delete" = $Delete
        "adx_append" = $Append
        "adx_appendto" = $AppendTo
        "adx_websiteid@odata.bind" = "/adx_websites($WebsiteId)"
    }

    $body = $permission | ConvertTo-Json -Depth 5

    try {
        $result = Invoke-RestMethod -Uri "$baseUrl/adx_entitypermissions" -Method Post -Headers $headers -Body $body
        Write-Host "Created table permission for: $TableLogicalName (ID: $permissionId)"
        return @{
            "Id" = $permissionId
            "Result" = $result
        }
    }
    catch {
        Write-Host "Error creating permission for $TableLogicalName : $_"
        return $null
    }
}
```

## Common Permission Patterns

### Read-Only Public Data

For tables like products, testimonials, FAQs that should be publicly readable:

```powershell
# Read-only Global scope for public data
New-TablePermission -Name "Product Read" -TableLogicalName "cr_product" -WebsiteId $websiteId -Read $true
New-TablePermission -Name "Team Member Read" -TableLogicalName "cr_teammember" -WebsiteId $websiteId -Read $true
New-TablePermission -Name "Testimonial Read" -TableLogicalName "cr_testimonial" -WebsiteId $websiteId -Read $true
New-TablePermission -Name "FAQ Read" -TableLogicalName "cr_faq" -WebsiteId $websiteId -Read $true
```

### Create-Only (Form Submissions)

For contact forms where users can submit but not read others' submissions:

```powershell
# Create only - users can submit but not read others
New-TablePermission -Name "Contact Submission Create" `
    -TableLogicalName "cr_contactsubmission" `
    -WebsiteId $websiteId `
    -Read $false `
    -Create $true
```

### User-Specific Data (Self Scope)

For data that users should only see their own records:

```powershell
# Self scope - users see only their own records
New-TablePermission -Name "User Profile" `
    -TableLogicalName "cr_userprofile" `
    -WebsiteId $websiteId `
    -Scope 756150004 `  # Self
    -Read $true `
    -Write $true
```

### Full CRUD Access

For authenticated users who need complete control:

```powershell
# Full CRUD access (use with caution)
New-TablePermission -Name "Admin Orders" `
    -TableLogicalName "cr_order" `
    -WebsiteId $websiteId `
    -Read $true `
    -Create $true `
    -Write $true `
    -Delete $true
```

## Assign Permissions to Web Roles

Table permissions must be linked to web roles to take effect.

### Get or Create Web Role

**IMPORTANT**: Always use `mspp_webroles` (not `adx_webroles`) for fetching web role IDs. If the role doesn't exist, create it first before proceeding with table permissions.

```powershell
function Get-OrCreateWebRole {
    param(
        [Parameter(Mandatory=$true)]
        [string]$RoleName,
        [Parameter(Mandatory=$true)]
        [string]$WebsiteId,
        [string]$Description = ""
    )

    # Try to get existing role using mspp_webroles
    try {
        $existingRole = Invoke-RestMethod `
            -Uri "$baseUrl/mspp_webroles?`$filter=mspp_name eq '$RoleName' and _mspp_websiteid_value eq $WebsiteId&`$select=mspp_webroleid" `
            -Headers $headers

        if ($existingRole.value.Count -gt 0) {
            $roleId = $existingRole.value[0].mspp_webroleid
            Write-Host "Found existing web role '$RoleName' with ID: $roleId"
            return $roleId
        }
    }
    catch {
        Write-Host "Error checking for existing role: $_"
    }

    # Role doesn't exist - create it
    Write-Host "Web role '$RoleName' not found. Creating..."

    $newRoleId = [guid]::NewGuid().ToString()
    $webRole = @{
        "mspp_webroleid" = $newRoleId
        "mspp_name" = $RoleName
        "mspp_description" = $Description
        "mspp_websiteid@odata.bind" = "/mspp_websites($WebsiteId)"
    }

    try {
        Invoke-RestMethod -Uri "$baseUrl/mspp_webroles" -Method Post -Headers $headers -Body ($webRole | ConvertTo-Json -Depth 5)
        Write-Host "Created web role '$RoleName' with ID: $newRoleId"
        return $newRoleId
    }
    catch {
        Write-Host "Error creating web role '$RoleName': $_"
        return $null
    }
}

# Example: Get or create Anonymous Users role
$roleId = Get-OrCreateWebRole -RoleName "Anonymous Users" -WebsiteId $websiteId -Description "Unauthenticated site visitors"

if (-not $roleId) {
    Write-Host "ERROR: Unable to get or create web role. Cannot proceed with table permission creation." -ForegroundColor Red
    return
}

Write-Host "Web Role ID: $roleId"
```

### Associate Permission with Role

**IMPORTANT**: Only create table permissions if you have a valid web role ID. If role retrieval/creation fails, do NOT create the permission.

```powershell
function Add-PermissionToRole {
    param(
        [Parameter(Mandatory=$true)]
        [string]$PermissionId,
        [Parameter(Mandatory=$true)]
        [string]$RoleId
    )

    if (-not $RoleId) {
        Write-Host "ERROR: No valid role ID provided. Cannot associate permission." -ForegroundColor Red
        return $false
    }

    $association = @{
        "@odata.id" = "$baseUrl/mspp_webroles($RoleId)"
    }

    try {
        Invoke-RestMethod `
            -Uri "$baseUrl/adx_entitypermissions($PermissionId)/adx_webrole_entitypermission/`$ref" `
            -Method Post `
            -Headers $headers `
            -Body ($association | ConvertTo-Json)
        Write-Host "Associated permission $PermissionId with role $RoleId"
        return $true
    }
    catch {
        Write-Host "Error associating permission: $_"
        return $false
    }
}
```

### Complete Example: Associate Permission

```powershell
# Get permission ID for a specific table
$permissions = Invoke-RestMethod `
    -Uri "$baseUrl/adx_entitypermissions?`$filter=adx_entitylogicalname eq 'cr_product'&`$select=adx_entitypermissionid" `
    -Headers $headers

if ($permissions.value.Count -gt 0) {
    $permissionId = $permissions.value[0].adx_entitypermissionid

    # Associate with Anonymous Users role
    Add-PermissionToRole -PermissionId $permissionId -RoleId $roleId
}
```

## Web Roles Reference

| Role | Description | Use Case |
|------|-------------|----------|
| **Anonymous Users** | Unauthenticated visitors | Public content access |
| **Authenticated Users** | Any logged-in user | Basic member features |
| **Administrators** | Full admin access | Site management |

## Verify Permissions

### List Existing Permissions

```powershell
# List all table permissions for the website
$existingPermissions = Invoke-RestMethod `
    -Uri "$baseUrl/adx_entitypermissions?`$filter=_adx_websiteid_value eq $websiteId&`$select=adx_entitylogicalname,adx_scope,adx_read,adx_create,adx_write,adx_delete" `
    -Headers $headers

$existingPermissions.value | ForEach-Object {
    Write-Host "Table: $($_.adx_entitylogicalname), Read: $($_.adx_read), Create: $($_.adx_create)"
}
```

### Check Role Associations

```powershell
# Check which roles are linked to a permission
$permissionId = "<PERMISSION_ID>"
$linkedRoles = Invoke-RestMethod `
    -Uri "$baseUrl/adx_entitypermissions($permissionId)/adx_webrole_entitypermission" `
    -Headers $headers

$linkedRoles.value | ForEach-Object {
    Write-Host "Linked Role: $($_.adx_name)"
}
```

## Code Site Table Permission Files

Table permissions for Power Pages code sites are stored as YAML files in the `.powerpages-site/table-permissions/` folder.

### Folder Structure

```
<PROJECT_ROOT>/
├── .powerpages-site/
│   ├── table-permissions/
│   │   ├── Product-Read-Permission.tablepermission.yml
│   │   ├── Contact-Self-Access.tablepermission.yml
│   │   └── ...
│   └── ...
```

### File Naming Convention

```
<Permission-Name>.tablepermission.yml
```

Example: `Product-Read-Permission.tablepermission.yml`

### YAML File Structure

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

**Important**: Field names do NOT include the `adx_` prefix (e.g., use `read` not `adx_read`), EXCEPT for many-to-many relationship fields like `adx_entitypermission_webrole` which retain the full name.

### YAML Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | GUID | Yes | Unique identifier for this permission |
| `entitylogicalname` | string | Yes | Dataverse table logical name (e.g., `cr_product`) |
| `entityname` | string | Yes | Display name for the permission |
| `scope` | int | Yes | Permission scope (see values below) |
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

### Scope Values for YAML

| Scope Name | Value | Description |
|------------|-------|-------------|
| Global | 756150000 | All records accessible |
| Contact | 756150001 | Records linked to current contact |
| Account | 756150002 | Records linked to user's account |
| Parent | 756150003 | Records linked via parent relationship |
| Self | 756150004 | Only records owned by current user |

### Generating Unique IDs

**IMPORTANT**: Every table permission YAML file must have a unique `id` field (UUID/GUID format).

**When creating YAML files directly**: Generate a valid UUID in the format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` where each `x` is a hexadecimal character (0-9, a-f). Each permission must have a different UUID.

**PowerShell** (if running scripts):
```powershell
[guid]::NewGuid().ToString()
```

**Bash/Linux/Mac**:
```bash
uuidgen | tr '[:upper:]' '[:lower:]'
# or
cat /proc/sys/kernel/random/uuid
```

**Python**:
```python
import uuid
print(str(uuid.uuid4()))
```

**Online**: Use any UUID generator website

**Example UUIDs** (do NOT reuse these - generate new ones):
- `71ecf203-dfe2-4c1e-9db2-112ed3925a52`
- `82fde314-eff3-5d2f-0ec3-223fe4036b63`
- `93gef425-fgg4-6e3g-1fd4-334gf5147c74`

### Example: Read-Only Public Permission

**Before creating**, get the web role GUID from the `.powerpages-site/web-roles/` folder. Each web role has a `.webrole.yml` file containing its `id`.

**Web Role File Format** (`.powerpages-site/web-roles/Anonymous-Users.webrole.yml`):
```yaml
anonymoususersrole: true
authenticatedusersrole: false
id: f0323770-7314-4f33-b904-21523abfbcb7
name: Anonymous Users
```

**Table Permission File** (`.powerpages-site/table-permissions/Product-Anonymous-Read.tablepermission.yml`):
```yaml
adx_entitypermission_webrole:
- f0323770-7314-4f33-b904-21523abfbcb7
append: false
appendto: false
create: false
delete: false
entitylogicalname: cr_product
entityname: Product - Anonymous Read
id: 71ecf203-dfe2-4c1e-9db2-112ed3925a52
parententitypermission:
read: true
scope: 756150000
write: false
```

### Example: User Self-Access Permission

**Web Role File** (`.powerpages-site/web-roles/Authenticated-Users.webrole.yml`):
```yaml
anonymoususersrole: false
authenticatedusersrole: true
id: ecac9573-effb-4d63-9b27-15861f70f3de
name: Authenticated Users
```

**Table Permission File** (`.powerpages-site/table-permissions/User-Profile-Self-Access.tablepermission.yml`):
```yaml
adx_entitypermission_webrole:
- ecac9573-effb-4d63-9b27-15861f70f3de
append: false
appendto: false
create: true
delete: false
entitylogicalname: cr_userprofile
entityname: User Profile - Self Access
id: 82fde314-eff3-5d2f-0ec3-223fe4036b63
parententitypermission:
read: true
scope: 756150004
write: true
```

### Parent-Child Table Permissions

When tables have relationships (e.g., Order → Order Items), you can create hierarchical permissions using the `parententitypermission` field and `Parent` scope.

> **Important**: Parent permissions must be created before child permissions. The child permission references the parent's ID in the `parententitypermission` field.

**Creation Order:**
1. Create the parent table permission first (e.g., for `cr_order`)
2. Note the parent permission's `id` (GUID)
3. Create child permission with `parententitypermission` set to parent's ID
4. Set child's `scope` to `756150003` (Parent)
5. Set `parentrelationship` to the relationship name between child and parent tables

#### Example: Parent Permission (Order)

**File**: `.powerpages-site/table-permissions/Order-User-Access.tablepermission.yml`
```yaml
adx_entitypermission_webrole:
- ecac9573-effb-4d63-9b27-15861f70f3de
append: true
appendto: false
create: true
delete: false
entitylogicalname: cr_order
entityname: Order - User Access
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
parententitypermission:
parentrelationship:
read: true
scope: 756150001
write: true
```

#### Example: Child Permission (Order Items)

**File**: `.powerpages-site/table-permissions/Order-Item-Parent-Access.tablepermission.yml`
```yaml
adx_entitypermission_webrole:
- ecac9573-effb-4d63-9b27-15861f70f3de
append: false
appendto: true
create: true
delete: true
entitylogicalname: cr_orderitem
entityname: Order Item - Parent Access
id: b2c3d4e5-f6a7-8901-bcde-fa2345678901
parententitypermission: a1b2c3d4-e5f6-7890-abcd-ef1234567890
parentrelationship: cr_order_orderitems
read: true
scope: 756150003
write: true
```

In this example, users can only access order items that belong to orders they have access to.

## Validation Checklist

Before uploading:

- [ ] All YAML files have valid syntax
- [ ] Each file has a unique UUID for the `id` field
- [ ] Fields are alphabetically sorted in the YAML file
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
