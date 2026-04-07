# API Authentication Reference

Uses Dataverse OData Web API with Azure CLI authentication (`az account get-access-token`).

## Prerequisites

Ensure Azure CLI is authenticated before proceeding:

```powershell
# Verify Azure CLI is logged in
az account show

# If not logged in, run:
az login
```

## Get Environment URL

```bash
pwsh -NoProfile -Command "pac org who"
```

Returns information including the environment URL (e.g., `https://orgname.crm.dynamics.com`).

## Get Access Token

```powershell
$envUrl = "https://<org>.crm.dynamics.com"  # Replace with your org URL
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)
```

## Set Up API Headers

```powershell
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
    "Prefer" = "return=representation"
}

$baseUrl = "$envUrl/api/data/v9.2"
```

## API Headers Reference

| Header                     | Value                   | Purpose                         |
| -------------------------- | ----------------------- | ------------------------------- |
| `Authorization`            | `Bearer <token>`        | Authentication token            |
| `Content-Type`             | `application/json`      | Request body format             |
| `OData-MaxVersion`         | `4.0`                   | Maximum OData version supported |
| `OData-Version`            | `4.0`                   | OData version to use            |
| `MSCRM.SolutionUniqueName` | Solution name           | Add created items to a solution |
| `Prefer`                   | `return=representation` | Return created record with ID   |

## Get Default Publisher Prefix

The publisher prefix is used for naming custom tables and columns. Fetch it dynamically:

```powershell
function Get-DefaultPublisherPrefix {
    param(
        [Parameter(Mandatory=$true)]
        [string]$BaseUrl,

        [Parameter(Mandatory=$true)]
        [hashtable]$Headers
    )

    $defaultPublisher = Invoke-RestMethod -Uri "$BaseUrl/publishers?`$filter=friendlyname eq 'CDS Default Publisher'&`$select=customizationprefix,friendlyname" -Headers $Headers

    if ($defaultPublisher.value.Count -eq 0) {
        throw "Could not find CDS Default Publisher in the environment"
    }

    $prefix = $defaultPublisher.value[0].customizationprefix
    Write-Host "Customization Prefix: $prefix" -ForegroundColor Cyan
    return $prefix
}
```

## Complete Setup Script

```powershell
function Initialize-DataverseApi {
    param(
        [Parameter(Mandatory=$true)]
        [string]$EnvironmentUrl,

        [string]$SolutionName = $null
    )

    $token = (az account get-access-token --resource $EnvironmentUrl --query accessToken -o tsv)

    if (-not $token) {
        throw "Failed to get access token. Make sure you're logged in with 'az login'"
    }

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
    $publisherPrefix = Get-DefaultPublisherPrefix -BaseUrl $baseUrl -Headers $headers

    return @{
        Headers = $headers
        BaseUrl = $baseUrl
        PublisherPrefix = $publisherPrefix
    }
}
```

## Token Refresh

Access tokens expire after ~1 hour. For long-running scripts:

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

```powershell
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
