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

    $permission = @{
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
        Write-Host "Created table permission for: $TableLogicalName"
        return $result
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

### Get Anonymous Users Role

```powershell
# Get the Anonymous Users web role ID
$anonymousRole = Invoke-RestMethod `
    -Uri "$baseUrl/adx_webroles?`$filter=adx_name eq 'Anonymous Users' and _adx_websiteid_value eq $websiteId&`$select=adx_webroleid" `
    -Headers $headers

if ($anonymousRole.value.Count -gt 0) {
    $roleId = $anonymousRole.value[0].adx_webroleid
    Write-Host "Anonymous Users Role ID: $roleId"
}
```

### Associate Permission with Role

```powershell
function Add-PermissionToRole {
    param(
        [string]$PermissionId,
        [string]$RoleId
    )

    $association = @{
        "@odata.id" = "$baseUrl/adx_webroles($RoleId)"
    }

    try {
        Invoke-RestMethod `
            -Uri "$baseUrl/adx_entitypermissions($PermissionId)/adx_webrole_entitypermission/`$ref" `
            -Method Post `
            -Headers $headers `
            -Body ($association | ConvertTo-Json)
        Write-Host "Associated permission $PermissionId with role $RoleId"
    }
    catch {
        Write-Host "Error associating permission: $_"
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

## PAC CLI Table Permission Files

When working with Power Platform CLI (`pac paportal download`), table permissions are stored as YAML files.

### File Naming Convention

```
<Permission-Name>.tablepermission.yml
```

Example: `Product-Read-Permission.tablepermission.yml`

### YAML File Structure

```yaml
append: false
appendto: false
create: false
delete: false
entitylogicalname: cr_product
entityname: Product Read Permission
entitypermission_webrole:
- 18c1fdce-684b-f011-877a-7c1e520c8613
id: 71ecf203-dfe2-4c1e-9db2-112ed3925a52
parententitypermission:
read: true
scope: 756150000
write: false
```

### YAML Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `entitylogicalname` | string | Dataverse table logical name (e.g., `cr_product`) |
| `entityname` | string | Display name for the permission |
| `id` | GUID | Unique identifier for this permission |
| `scope` | int | Permission scope (see values below) |
| `read` | bool | Can retrieve/query records |
| `create` | bool | Can create new records |
| `write` | bool | Can update existing records |
| `delete` | bool | Can delete records |
| `append` | bool | Can associate records to this entity |
| `appendto` | bool | Can associate this entity to other records |
| `entitypermission_webrole` | list | GUIDs of web roles with this permission |
| `parententitypermission` | GUID | Parent permission ID for hierarchical access |

### Scope Values for YAML

| Scope Name | Value | Description |
|------------|-------|-------------|
| Global | 756150000 | All records accessible |
| Contact | 756150001 | Records linked to current contact |
| Account | 756150002 | Records linked to user's account |
| Parent | 756150003 | Records linked via parent relationship |
| Self | 756150004 | Only records owned by current user |

### Example: Read-Only Public Permission

```yaml
append: false
appendto: false
create: false
delete: false
entitylogicalname: cr_product
entityname: Product - Anonymous Read
entitypermission_webrole:
- <anonymous-users-webrole-guid>
id: <new-guid>
parententitypermission:
read: true
scope: 756150000
write: false
```

### Example: User Self-Access Permission

```yaml
append: false
appendto: false
create: true
delete: false
entitylogicalname: cr_userprofile
entityname: User Profile - Self Access
entitypermission_webrole:
- <authenticated-users-webrole-guid>
id: <new-guid>
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

#### Example: Parent Permission (Order)

```yaml
append: true
appendto: false
create: true
delete: false
entitylogicalname: cr_order
entityname: Order - User Access
entitypermission_webrole:
- <authenticated-users-webrole-guid>
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
parententitypermission:
read: true
scope: 756150001
write: true
```

#### Example: Child Permission (Order Items)

```yaml
append: false
appendto: true
create: true
delete: true
entitylogicalname: cr_orderitem
entityname: Order Item - Parent Access
entitypermission_webrole:
- <authenticated-users-webrole-guid>
id: <new-guid>
parententitypermission: a1b2c3d4-e5f6-7890-abcd-ef1234567890
read: true
scope: 756150003
write: true
```

In this example, users can only access order items that belong to orders they have access to.

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
