# API Authentication Reference

This document covers setting up authentication for the Dataverse OData Web API.

## Overview

This skill uses the Dataverse OData Web API for all table and data operations:

1. **Dataverse Web API** for table creation, schema management, and data operations
2. **Azure CLI** for authentication (`az account get-access-token`)
3. **PowerShell** for scripting API calls
4. **Client-side `/_api/` calls** from the Power Pages site for runtime data access

## Prerequisites

Ensure Azure CLI is authenticated before proceeding:

```powershell
# Verify Azure CLI is logged in
az account show

# If not logged in, run:
az login
```

## Get Environment URL

Get your Dataverse environment URL:

```powershell
# Using PAC CLI
pac org who
```

This returns information including the environment URL (e.g., `https://orgname.crm.dynamics.com`).

## Get Access Token

```powershell
# Get access token using Azure CLI
$envUrl = "https://<org>.crm.dynamics.com"  # Replace with your org URL
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)
```

## Set Up API Headers

```powershell
# Set up headers for API calls
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
    "MSCRM.SolutionUniqueName" = "YourSolutionName"  # Optional: add to a solution
}

$baseUrl = "$envUrl/api/data/v9.2"
```

## API Headers Reference

| Header | Value | Purpose |
|--------|-------|---------|
| `Authorization` | `Bearer <token>` | Authentication token |
| `Content-Type` | `application/json` | Request body format |
| `OData-MaxVersion` | `4.0` | Maximum OData version supported |
| `OData-Version` | `4.0` | OData version to use |
| `MSCRM.SolutionUniqueName` | Solution name | Add created items to a solution |
| `Prefer` | `return=representation` | Return created record with ID |

## Complete Setup Script

```powershell
# Complete API setup script
function Initialize-DataverseApi {
    param(
        [Parameter(Mandatory=$true)]
        [string]$EnvironmentUrl,

        [string]$SolutionName = $null
    )

    # Get access token
    $token = (az account get-access-token --resource $EnvironmentUrl --query accessToken -o tsv)

    if (-not $token) {
        throw "Failed to get access token. Make sure you're logged in with 'az login'"
    }

    # Set up headers
    $headers = @{
        "Authorization" = "Bearer $token"
        "Content-Type" = "application/json"
        "OData-MaxVersion" = "4.0"
        "OData-Version" = "4.0"
        "Prefer" = "return=representation"
    }

    if ($SolutionName) {
        $headers["MSCRM.SolutionUniqueName"] = $SolutionName
    }

    $baseUrl = "$EnvironmentUrl/api/data/v9.2"

    # Store in script-level variables for reuse
    $script:DataverseHeaders = $headers
    $script:DataverseBaseUrl = $baseUrl

    Write-Host "Dataverse API initialized successfully" -ForegroundColor Green
    Write-Host "  Environment: $EnvironmentUrl" -ForegroundColor Cyan
    Write-Host "  Base URL: $baseUrl" -ForegroundColor Cyan

    return @{
        Headers = $headers
        BaseUrl = $baseUrl
    }
}

# Usage example:
# $api = Initialize-DataverseApi -EnvironmentUrl "https://orgname.crm.dynamics.com"
# $headers = $api.Headers
# $baseUrl = $api.BaseUrl
```

## Token Refresh

Access tokens expire after approximately 1 hour. For long-running scripts, implement token refresh:

```powershell
function Get-FreshToken {
    param([string]$EnvironmentUrl)

    return (az account get-access-token --resource $EnvironmentUrl --query accessToken -o tsv)
}

function Invoke-DataverseApi {
    param(
        [string]$Uri,
        [string]$Method = "Get",
        [hashtable]$Headers,
        [string]$Body = $null,
        [string]$EnvironmentUrl
    )

    try {
        if ($Body) {
            return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers -Body $Body
        } else {
            return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers
        }
    } catch {
        if ($_.Exception.Response.StatusCode -eq 401) {
            # Token expired, refresh and retry
            Write-Host "Token expired, refreshing..." -ForegroundColor Yellow
            $newToken = Get-FreshToken -EnvironmentUrl $EnvironmentUrl
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

Test the API connection:

```powershell
# Test API connection
try {
    $whoami = Invoke-RestMethod -Uri "$baseUrl/WhoAmI" -Headers $headers
    Write-Host "Connected as: $($whoami.UserId)" -ForegroundColor Green
} catch {
    Write-Host "Connection failed: $($_.Exception.Message)" -ForegroundColor Red
}
```

## Required Permissions

To create tables and manage schema, you need one of these Dataverse security roles:

- **System Administrator** - Full access
- **System Customizer** - Can create and modify tables

To verify your permissions:

```powershell
# Get current user's security roles
$userId = (Invoke-RestMethod -Uri "$baseUrl/WhoAmI" -Headers $headers).UserId
$roles = Invoke-RestMethod -Uri "$baseUrl/systemusers($userId)/systemuserroles_association?`$select=name" -Headers $headers
Write-Host "Your security roles:" -ForegroundColor Cyan
$roles.value | ForEach-Object { Write-Host "  - $($_.name)" }
```
