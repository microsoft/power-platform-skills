# Web Roles Reference

This document describes how to create and configure web roles for Power Pages sites. Web roles control access to content and data, and must be created before table permissions.

## Understanding Web Roles

Web roles define user groups with specific access levels. They are the foundation of Power Pages security model and determine:

- Which pages users can access
- What data users can read/write via Web API
- Which site features are available to users

### Built-in Web Roles

Power Pages creates these default web roles when a site is provisioned:

| Web Role | Description | Typical Use Case |
|----------|-------------|------------------|
| **Anonymous Users** | Unauthenticated site visitors | Public content, read-only product catalogs, FAQs |
| **Authenticated Users** | Any user who has signed in | Basic member features, form submissions |
| **Administrators** | Full administrative access | Site management, content editing |

### Custom Web Roles

Create custom web roles for granular access control:

| Custom Role Example | Description | Use Case |
|---------------------|-------------|----------|
| **Customers** | Registered customers | View orders, submit support tickets |
| **Partners** | Business partners | Access partner portal, view deals |
| **Employees** | Internal staff | HR portal, internal tools |
| **Premium Members** | Paid subscribers | Access premium content, features |
| **Moderators** | Content moderators | Approve submissions, manage comments |
| **Support Agents** | Customer support team | View/respond to tickets |

## Prerequisites

Before creating web roles, ensure you have:

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

## Determine Appropriate Web Roles

Use this decision matrix to determine which web roles you need:

### Role Selection by Feature

| Site Feature | Required Roles | Notes |
|--------------|----------------|-------|
| Public landing page | Anonymous Users | No authentication needed |
| Product/Service catalog | Anonymous Users | Read-only public data |
| Contact form submission | Anonymous Users | Create-only permission |
| User registration | Anonymous Users → Authenticated Users | Transition after sign-up |
| User dashboard | Authenticated Users | Requires sign-in |
| Order history | Customers (custom) | User-specific data |
| Admin panel | Administrators | Restricted access |
| Partner portal | Partners (custom) | Business partner access |
| Premium content | Premium Members (custom) | Subscription-based |

### Role Selection by Operation

| Operation | Minimum Role | Recommended Role | Security Notes |
|-----------|--------------|------------------|----------------|
| View public content | Anonymous Users | Anonymous Users | Safe for all visitors |
| Submit forms | Anonymous Users | Anonymous Users | Create-only, no read |
| View own data | Authenticated Users | Custom role (e.g., Customers) | Self scope |
| Edit own data | Authenticated Users | Custom role (e.g., Customers) | Self scope |
| View all records | Administrators | Custom admin role | Global scope, audit access |
| Delete records | Administrators | Custom admin role | Highly restricted |

### Role Hierarchy Example

```text
┌─────────────────────────────────────────────────────────────────┐
│                        ADMINISTRATORS                            │
│  • Full site access                                              │
│  • Manage all content and users                                  │
│  • Global scope permissions                                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓ inherits
┌─────────────────────────────────────────────────────────────────┐
│                     AUTHENTICATED USERS                          │
│  • Signed-in users                                               │
│  • Access protected pages                                        │
│  • Self/Contact scope permissions                                │
├─────────────────────────────────────────────────────────────────┤
│  Custom roles (same level):                                      │
│  • Customers - Order management, support tickets                 │
│  • Partners - Partner portal, deal management                    │
│  • Employees - Internal HR, tools                                │
│  • Premium Members - Premium content access                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓ base level
┌─────────────────────────────────────────────────────────────────┐
│                      ANONYMOUS USERS                             │
│  • Public visitors (no sign-in)                                  │
│  • Read public content only                                      │
│  • Submit forms (create-only)                                    │
│  • Global scope, read-only                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Create Web Role Function

**IMPORTANT**: Always use `mspp_webroles` (not `adx_webroles`) for creating and querying web roles.

```powershell
function New-WebRole {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Name,

        [Parameter(Mandatory=$true)]
        [string]$WebsiteId,

        [string]$Description = "",

        [bool]$AuthenticatedUsersRole = $false,

        [bool]$AnonymousUsersRole = $false
    )

    # Generate unique ID for the web role (see alternatives below for non-PowerShell)
    $webRoleId = [guid]::NewGuid().ToString()

    $webRole = @{
        "mspp_webroleid" = $webRoleId
        "mspp_name" = $Name
        "mspp_description" = $Description
        "mspp_authenticatedusersrole" = $AuthenticatedUsersRole
        "mspp_anonymoususersrole" = $AnonymousUsersRole
        "mspp_websiteid@odata.bind" = "/mspp_websites($WebsiteId)"
    }

    $body = $webRole | ConvertTo-Json -Depth 5

    try {
        Invoke-RestMethod -Uri "$baseUrl/mspp_webroles" -Method Post -Headers $headers -Body $body
        Write-Host "Created web role '$Name' with ID: $webRoleId"
        return $webRoleId
    }
    catch {
        Write-Host "Error creating web role '$Name': $_"
        return $null
    }
}
```

### Alternative UUID Generation Methods

If not using PowerShell, generate UUIDs using:

**Bash/Linux/Mac**:
```bash
uuidgen | tr '[:upper:]' '[:lower:]'
```

**Python**:
```python
import uuid
print(str(uuid.uuid4()))
```

**Online**: Use any UUID generator website

## Common Web Role Patterns

### Pattern 1: Public Website (Anonymous + Admin)

For simple public websites with admin management:

```powershell
# Anonymous Users - already exists, just verify (use mspp_webroles)
$anonymousRole = Invoke-RestMethod `
    -Uri "$baseUrl/mspp_webroles?`$filter=mspp_name eq 'Anonymous Users' and _mspp_websiteid_value eq $websiteId" `
    -Headers $headers

# Administrators - already exists, just verify
$adminRole = Invoke-RestMethod `
    -Uri "$baseUrl/mspp_webroles?`$filter=mspp_name eq 'Administrators' and _mspp_websiteid_value eq $websiteId" `
    -Headers $headers

Write-Host "Using existing roles: Anonymous Users, Administrators"
```

### Pattern 2: Member Portal (Add Authenticated Users)

For sites requiring user sign-in:

```powershell
# Verify Authenticated Users role exists (use mspp_webroles)
$authRole = Invoke-RestMethod `
    -Uri "$baseUrl/mspp_webroles?`$filter=mspp_name eq 'Authenticated Users' and _mspp_websiteid_value eq $websiteId" `
    -Headers $headers

if ($authRole.value.Count -eq 0) {
    # Create Authenticated Users role
    New-WebRole -Name "Authenticated Users" `
                -WebsiteId $websiteId `
                -Description "Users who have signed in to the site" `
                -AuthenticatedUsersRole $true
}
```

### Pattern 3: Customer Portal (Custom Customer Role)

For customer-facing portals with order management:

```powershell
# Create Customers role
$customerRoleId = New-WebRole -Name "Customers" `
    -WebsiteId $websiteId `
    -Description "Registered customers with access to orders and support"

# Create Support Agents role (for customer service team)
$supportRoleId = New-WebRole -Name "Support Agents" `
    -WebsiteId $websiteId `
    -Description "Customer support team members"
```

### Pattern 4: Partner Portal (Custom Partner Role)

For B2B partner portals:

```powershell
# Create Partners role
$partnerRoleId = New-WebRole -Name "Partners" `
    -WebsiteId $websiteId `
    -Description "Business partners with access to partner portal"

# Create Partner Managers role
$partnerManagerRoleId = New-WebRole -Name "Partner Managers" `
    -WebsiteId $websiteId `
    -Description "Internal team managing partner relationships"
```

### Pattern 5: Subscription Site (Premium Members)

For sites with premium/paid content:

```powershell
# Create Premium Members role
$premiumRoleId = New-WebRole -Name "Premium Members" `
    -WebsiteId $websiteId `
    -Description "Users with active premium subscription"

# Create Free Members role
$freeRoleId = New-WebRole -Name "Free Members" `
    -WebsiteId $websiteId `
    -Description "Users with free tier access"
```

### Pattern 6: Employee Portal (Internal Staff)

For internal company portals:

```powershell
# Create Employees role
$employeeRoleId = New-WebRole -Name "Employees" `
    -WebsiteId $websiteId `
    -Description "Internal company employees"

# Create Managers role
$managerRoleId = New-WebRole -Name "Managers" `
    -WebsiteId $websiteId `
    -Description "Department managers with elevated access"

# Create HR role
$hrRoleId = New-WebRole -Name "HR Team" `
    -WebsiteId $websiteId `
    -Description "Human resources team members"
```

## Get Existing Web Roles

### List All Web Roles

```powershell
function Get-WebRoles {
    param(
        [Parameter(Mandatory=$true)]
        [string]$WebsiteId
    )

    # Use mspp_webroles (not adx_webroles)
    $roles = Invoke-RestMethod `
        -Uri "$baseUrl/mspp_webroles?`$filter=_mspp_websiteid_value eq $WebsiteId&`$select=mspp_webroleid,mspp_name,mspp_description,mspp_authenticatedusersrole,mspp_anonymoususersrole" `
        -Headers $headers

    return $roles.value
}

# Get all roles for the website
$allRoles = Get-WebRoles -WebsiteId $websiteId
$allRoles | ForEach-Object {
    Write-Host "Role: $($_.mspp_name) | ID: $($_.mspp_webroleid) | Auth Required: $($_.mspp_authenticatedusersrole) | Anonymous: $($_.mspp_anonymoususersrole)"
}
```

### Get Specific Web Role ID

```powershell
function Get-WebRoleId {
    param(
        [Parameter(Mandatory=$true)]
        [string]$RoleName,

        [Parameter(Mandatory=$true)]
        [string]$WebsiteId
    )

    # Use mspp_webroles (not adx_webroles)
    $role = Invoke-RestMethod `
        -Uri "$baseUrl/mspp_webroles?`$filter=mspp_name eq '$RoleName' and _mspp_websiteid_value eq $WebsiteId&`$select=mspp_webroleid" `
        -Headers $headers

    if ($role.value.Count -gt 0) {
        return $role.value[0].mspp_webroleid
    }
    return $null
}

# Example usage
$anonymousRoleId = Get-WebRoleId -RoleName "Anonymous Users" -WebsiteId $websiteId
$authRoleId = Get-WebRoleId -RoleName "Authenticated Users" -WebsiteId $websiteId
$adminRoleId = Get-WebRoleId -RoleName "Administrators" -WebsiteId $websiteId
```

## Assign Users to Web Roles

### Associate Contact with Web Role

```powershell
function Add-ContactToWebRole {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ContactId,

        [Parameter(Mandatory=$true)]
        [string]$WebRoleId
    )

    $association = @{
        "@odata.id" = "$baseUrl/contacts($ContactId)"
    }

    try {
        # Use mspp_webroles (not adx_webroles)
        Invoke-RestMethod `
            -Uri "$baseUrl/mspp_webroles($WebRoleId)/mspp_webrole_contact/`$ref" `
            -Method Post `
            -Headers $headers `
            -Body ($association | ConvertTo-Json)
        Write-Host "Added contact $ContactId to web role $WebRoleId"
    }
    catch {
        Write-Host "Error adding contact to role: $_"
    }
}

# Example: Add a contact to Customers role
# $contactId = "<CONTACT_GUID>"
# $customersRoleId = Get-WebRoleId -RoleName "Customers" -WebsiteId $websiteId
# Add-ContactToWebRole -ContactId $contactId -WebRoleId $customersRoleId
```

### Remove Contact from Web Role

```powershell
function Remove-ContactFromWebRole {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ContactId,

        [Parameter(Mandatory=$true)]
        [string]$WebRoleId
    )

    try {
        # Use mspp_webroles (not adx_webroles)
        Invoke-RestMethod `
            -Uri "$baseUrl/mspp_webroles($WebRoleId)/mspp_webrole_contact($ContactId)/`$ref" `
            -Method Delete `
            -Headers $headers
        Write-Host "Removed contact $ContactId from web role $WebRoleId"
    }
    catch {
        Write-Host "Error removing contact from role: $_"
    }
}
```

## Web Role and Table Permission Matrix

After creating web roles, use this matrix to plan table permissions:

| Table Type | Anonymous Users | Authenticated Users | Custom Role | Administrators |
|------------|-----------------|---------------------|-------------|----------------|
| Products (public) | Read | Read | Read | Full CRUD |
| FAQs (public) | Read | Read | Read | Full CRUD |
| Contact submissions | Create | Create | Create | Read, Delete |
| User profiles | - | Read/Write (Self) | Read/Write (Self) | Full CRUD |
| Orders | - | - | Read/Write (Contact) | Full CRUD |
| Support tickets | - | Create | Read/Write (Self) | Full CRUD |
| Partner deals | - | - | Read/Write (Account) | Full CRUD |
| Admin settings | - | - | - | Full CRUD |

## Complete Setup Script

Here's a complete script to set up web roles for a typical site:

```powershell
# ============================================
# Power Pages Web Roles Setup Script
# ============================================

param(
    [Parameter(Mandatory=$true)]
    [string]$WebsiteId,

    [Parameter(Mandatory=$false)]
    [string[]]$CustomRoles = @()
)

# Setup authentication
$envUrl = (pac org who --json | ConvertFrom-Json).OrgUrl
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
}

$baseUrl = "$envUrl/api/data/v9.2"

# Verify default roles exist (use mspp_webroles)
Write-Host "`n=== Verifying Default Web Roles ===" -ForegroundColor Cyan

$defaultRoles = @("Anonymous Users", "Authenticated Users", "Administrators")
$roleIds = @{}

foreach ($roleName in $defaultRoles) {
    $role = Invoke-RestMethod `
        -Uri "$baseUrl/mspp_webroles?`$filter=mspp_name eq '$roleName' and _mspp_websiteid_value eq $WebsiteId" `
        -Headers $headers

    if ($role.value.Count -gt 0) {
        $roleIds[$roleName] = $role.value[0].mspp_webroleid
        Write-Host "✓ Found: $roleName (ID: $($roleIds[$roleName]))" -ForegroundColor Green
    } else {
        Write-Host "✗ Missing: $roleName" -ForegroundColor Yellow
    }
}

# Create custom roles if specified
if ($CustomRoles.Count -gt 0) {
    Write-Host "`n=== Creating Custom Web Roles ===" -ForegroundColor Cyan

    foreach ($customRole in $CustomRoles) {
        $existingRole = Invoke-RestMethod `
            -Uri "$baseUrl/mspp_webroles?`$filter=mspp_name eq '$customRole' and _mspp_websiteid_value eq $WebsiteId" `
            -Headers $headers

        if ($existingRole.value.Count -eq 0) {
            $roleId = New-WebRole -Name $customRole -WebsiteId $WebsiteId -Description "Custom role: $customRole"
            if ($roleId) {
                $roleIds[$customRole] = $roleId
                Write-Host "✓ Created: $customRole" -ForegroundColor Green
            }
        } else {
            $roleIds[$customRole] = $existingRole.value[0].mspp_webroleid
            Write-Host "→ Already exists: $customRole" -ForegroundColor Yellow
        }
    }
}

# Output summary
Write-Host "`n=== Web Roles Summary ===" -ForegroundColor Cyan
$roleIds.GetEnumerator() | ForEach-Object {
    Write-Host "  $($_.Key): $($_.Value)"
}

return $roleIds
```

### Usage Examples

```powershell
# Basic setup (verify default roles only)
$roleIds = .\Setup-WebRoles.ps1 -WebsiteId $websiteId

# Customer portal setup
$roleIds = .\Setup-WebRoles.ps1 -WebsiteId $websiteId -CustomRoles @("Customers", "Support Agents")

# Partner portal setup
$roleIds = .\Setup-WebRoles.ps1 -WebsiteId $websiteId -CustomRoles @("Partners", "Partner Managers")

# Full enterprise setup
$roleIds = .\Setup-WebRoles.ps1 -WebsiteId $websiteId -CustomRoles @(
    "Customers",
    "Partners",
    "Employees",
    "Premium Members",
    "Support Agents"
)
```

## Security Best Practices

1. **Principle of Least Privilege**: Assign users the minimum role needed for their tasks
2. **Avoid Administrator Role**: Create specific roles instead of broadly using Administrators
3. **Separate Read and Write Roles**: Consider separate roles for viewing vs. modifying data
4. **Regular Audits**: Review role assignments periodically
5. **Document Role Purposes**: Maintain clear descriptions for each custom role
6. **Test Role Permissions**: Verify access levels before production deployment

## Next Steps

After creating web roles:

1. **Create Table Permissions**: Use `table-permissions-reference.md` to set up data access
2. **Associate Permissions with Roles**: Link table permissions to appropriate web roles
3. **Configure Site Settings**: Enable Web API for required tables
4. **Test Access Levels**: Verify each role has correct access

## Reference Documentation

- [Configure web roles - Microsoft Learn](https://learn.microsoft.com/en-us/power-pages/security/create-web-roles)
- [Table permissions - Microsoft Learn](https://learn.microsoft.com/en-us/power-pages/security/table-permissions)
- [Web API security - Microsoft Learn](https://learn.microsoft.com/en-us/power-pages/configure/web-api-security)
