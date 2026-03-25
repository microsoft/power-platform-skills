# API Authentication Reference

Uses Microsoft Graph API with Azure CLI authentication (`az account get-access-token`) to manage SharePoint lists and columns.

## Prerequisites

Ensure Azure CLI is authenticated before proceeding:

```powershell
# Verify Azure CLI is logged in
az account show

# If not logged in, run:
az login
```

## Get Access Token

```powershell
$token = (az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)
```

## Set Up API Headers

```powershell
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}
```

## API Headers Reference

| Header | Value | Purpose |
|--------|-------|---------|
| `Authorization` | `Bearer <token>` | Authentication token |
| `Content-Type` | `application/json` | Request body format |
| `Prefer` | `HonorNonIndexedQueriesWarningMayFailRandomly` | Allow non-indexed queries (optional) |

## Get Site ID from URL

SharePoint site URLs follow the pattern `https://{tenant}.sharepoint.com/sites/{site-name}`. Extract the site ID using the Graph API:

```powershell
function Get-SiteId {
    param(
        [Parameter(Mandatory=$true)]
        [string]$SiteUrl,

        [Parameter(Mandatory=$true)]
        [hashtable]$Headers
    )

    # Parse the URL into hostname and server-relative path
    $uri = [System.Uri]$SiteUrl
    $hostname = $uri.Host
    $serverRelativePath = $uri.AbsolutePath.TrimEnd('/')

    $graphUrl = "https://graph.microsoft.com/v1.0/sites/${hostname}:${serverRelativePath}"
    $site = Invoke-RestMethod -Uri $graphUrl -Headers $Headers
    return $site.id
}
```

## Complete Setup Script

```powershell
function Initialize-SharePointGraphApi {
    param(
        [Parameter(Mandatory=$true)]
        [string]$SiteUrl
    )

    $token = (az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)

    if (-not $token) {
        throw "Failed to get access token. Make sure you're logged in with 'az login'"
    }

    $headers = @{
        "Authorization" = "Bearer $token"
        "Content-Type" = "application/json"
    }

    $siteId = Get-SiteId -SiteUrl $SiteUrl -Headers $headers

    Write-Host "Connected to site: $SiteUrl" -ForegroundColor Green
    Write-Host "Site ID: $siteId" -ForegroundColor Cyan

    return @{
        Headers = $headers
        SiteId = $siteId
        SiteUrl = $SiteUrl
    }
}
```

## Token Refresh

Access tokens expire after ~1 hour. For long-running scripts:

```powershell
function Get-FreshToken {
    return (az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)
}

function Invoke-GraphApi {
    param(
        [string]$Uri,
        [string]$Method = "Get",
        [hashtable]$Headers,
        [string]$Body = $null
    )

    try {
        if ($Body) {
            return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers -Body $Body
        } else {
            return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers
        }
    } catch {
        if ($_.Exception.Response.StatusCode -eq 401) {
            Write-Host "Token expired, refreshing..." -ForegroundColor Yellow
            $newToken = Get-FreshToken
            $Headers["Authorization"] = "Bearer $newToken"

            if ($Body) {
                return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers -Body $Body
            } else {
                return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers
            }
        }
        throw
    }
}
```

## Verify Connection

```powershell
try {
    $site = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$siteId" -Headers $headers
    Write-Host "Connected to: $($site.displayName)" -ForegroundColor Green
    Write-Host "Web URL: $($site.webUrl)" -ForegroundColor Cyan
} catch {
    Write-Host "Connection failed: $($_.Exception.Message)" -ForegroundColor Red
}
```

## Required Permissions

To create lists and manage columns via Graph API, the Azure CLI app registration needs:

- **Sites.Manage.All** - Create and manage lists, list items, and columns
- **Sites.Read.All** - Read site and list metadata (minimum for discovery)
