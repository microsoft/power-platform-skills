# List Management Reference

## Query Existing Lists

Before creating lists, review what exists on the site:

```powershell
$existingLists = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists?`$select=id,displayName,description,list&`$filter=list/hidden eq false" -Headers $headers

Write-Host "Found $($existingLists.value.Count) lists:" -ForegroundColor Cyan
$existingLists.value | ForEach-Object {
    $template = $_.list.template
    Write-Host "  - $($_.displayName) ($template)" -ForegroundColor Yellow
}
```

## Get List Schema

```powershell
function Get-ListSchema {
    param(
        [string]$SiteId,
        [string]$ListId,
        [hashtable]$Headers
    )

    $list = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$SiteId/lists/$ListId/columns" -Headers $Headers

    Write-Host "`nList columns:" -ForegroundColor Cyan
    $list.value | Where-Object {
        -not $_.readOnly -and $_.name -notin @('ContentType', 'Attachments', '_ModerationComments', '_ModerationStatus', 'Edit', 'LinkTitleNoMenu', 'LinkTitle', 'DocIcon', 'ItemChildCount', 'FolderChildCount', '_ComplianceFlags', '_ComplianceTag', '_ComplianceTagWrittenTime', '_ComplianceTagUserId')
    } | ForEach-Object {
        $type = if ($_.text) { "text" } elseif ($_.number) { "number" } elseif ($_.choice) { "choice" } elseif ($_.dateTime) { "dateTime" } elseif ($_.boolean) { "boolean" } elseif ($_.lookup) { "lookup" } elseif ($_.personOrGroup) { "personOrGroup" } else { "unknown" }
        Write-Host "    - $($_.displayName) [$($_.name)] ($type)"
    }

    return $list
}
```

## Check If List/Column Exists

```powershell
function Test-ListExists {
    param(
        [string]$SiteId,
        [string]$DisplayName,
        [hashtable]$Headers
    )

    $lists = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$SiteId/lists?`$filter=displayName eq '$DisplayName'" -Headers $Headers
    return $lists.value.Count -gt 0
}

function Test-ColumnExists {
    param(
        [string]$SiteId,
        [string]$ListId,
        [string]$ColumnName,
        [hashtable]$Headers
    )

    try {
        $columns = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$SiteId/lists/$ListId/columns" -Headers $Headers
        $match = $columns.value | Where-Object { $_.name -eq $ColumnName -or $_.displayName -eq $ColumnName }
        return $null -ne $match
    } catch {
        if ($_.Exception.Response.StatusCode -eq 404) { return $false }
        throw
    }
}
```

## Find Similar Lists

Search for lists with similar purposes but different names:

```powershell
function Find-SimilarLists {
    param(
        [string]$Purpose,
        [array]$ExistingLists
    )

    $patterns = @{
        "task" = @("task", "tasks", "todo", "to-do", "action", "actions", "work item")
        "contact" = @("contact", "contacts", "people", "person", "directory", "employee", "staff")
        "project" = @("project", "projects", "initiative", "program")
        "issue" = @("issue", "issues", "bug", "bugs", "incident", "ticket", "request")
        "inventory" = @("inventory", "asset", "assets", "equipment", "stock", "item", "items")
        "event" = @("event", "events", "calendar", "meeting", "schedule")
        "document" = @("document", "documents", "file", "files", "library")
    }

    $searchTerms = $patterns[$Purpose]
    if (-not $searchTerms) { $searchTerms = @($Purpose) }

    $matches = $ExistingLists | Where-Object {
        $listName = $_.displayName.ToLower()
        $listDesc = if ($_.description) { $_.description.ToLower() } else { "" }

        foreach ($term in $searchTerms) {
            if ($listName -match $term -or $listDesc -match $term) {
                return $true
            }
        }
        return $false
    }

    return $matches
}
```

## Compare Existing vs Required Lists

```powershell
function Compare-ListSchemas {
    param(
        [hashtable]$RequiredLists,  # Purpose name -> array of required column names
        [array]$ExistingLists,
        [string]$SiteId,
        [hashtable]$Headers
    )

    $comparison = @{
        Reusable = @()
        Extendable = @()
        CreateNew = @()
    }

    foreach ($listPurpose in $RequiredLists.Keys) {
        $existing = Find-SimilarLists -Purpose $listPurpose -ExistingLists $ExistingLists | Select-Object -First 1

        if ($existing) {
            $schema = Get-ListSchema -SiteId $SiteId -ListId $existing.id -Headers $Headers
            $existingColumns = $schema.value | Select-Object -ExpandProperty name
            $requiredColumns = $RequiredLists[$listPurpose]
            $missingColumns = $requiredColumns | Where-Object { $_ -notin $existingColumns }

            if ($missingColumns.Count -eq 0) {
                $comparison.Reusable += @{
                    ListPurpose = $listPurpose
                    ListId = $existing.id
                    DisplayName = $existing.displayName
                    Message = "All required columns present"
                }
            } else {
                $comparison.Extendable += @{
                    ListPurpose = $listPurpose
                    ListId = $existing.id
                    DisplayName = $existing.displayName
                    MissingColumns = $missingColumns
                    Message = "Missing columns: $($missingColumns -join ', ')"
                }
            }
        } else {
            $comparison.CreateNew += @{
                ListPurpose = $listPurpose
                RequiredColumns = $RequiredLists[$listPurpose]
            }
        }
    }

    return $comparison
}
```

## Create List

```powershell
function New-SharePointList {
    param(
        [string]$SiteId,
        [string]$DisplayName,
        [string]$Description = "",
        [hashtable]$Headers
    )

    $listDefinition = @{
        displayName = $DisplayName
        description = $Description
        list = @{
            template = "genericList"
        }
    }

    $body = $listDefinition | ConvertTo-Json -Depth 5
    $result = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$SiteId/lists" -Method Post -Headers $Headers -Body $body
    return $result
}

function New-SharePointListIfNotExists {
    param(
        [string]$SiteId,
        [string]$DisplayName,
        [string]$Description = "",
        [hashtable]$Headers
    )

    if (Test-ListExists -SiteId $SiteId -DisplayName $DisplayName -Headers $Headers) {
        Write-Host "  [SKIP] List '$DisplayName' already exists" -ForegroundColor Yellow
        $existing = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$SiteId/lists?`$filter=displayName eq '$DisplayName'" -Headers $Headers
        return @{ Skipped = $true; List = $existing.value[0] }
    }

    Write-Host "  [CREATE] Creating list '$DisplayName'..." -ForegroundColor Cyan
    $result = New-SharePointList -SiteId $SiteId -DisplayName $DisplayName -Description $Description -Headers $Headers
    Write-Host "  [OK] List '$DisplayName' created (ID: $($result.id))" -ForegroundColor Green
    return @{ Skipped = $false; List = $result }
}
```

## Add Columns

```powershell
function Add-SharePointColumn {
    param(
        [string]$SiteId,
        [string]$ListId,
        [string]$Name,
        [string]$DisplayName,
        [string]$Type,  # text, number, choice, dateTime, boolean
        [string[]]$Choices = @(),
        [hashtable]$Headers
    )

    $columnDefinition = @{
        name = $Name
        displayName = $DisplayName
        enforceUniqueValues = $false
    }

    switch ($Type) {
        "text" {
            $columnDefinition["text"] = @{
                allowMultipleLines = $false
                maxLength = 255
            }
        }
        "multilineText" {
            $columnDefinition["text"] = @{
                allowMultipleLines = $true
            }
        }
        "number" {
            $columnDefinition["number"] = @{}
        }
        "choice" {
            $columnDefinition["choice"] = @{
                allowTextEntry = $false
                choices = $Choices
                displayAs = "dropDownMenu"
            }
        }
        "dateTime" {
            $columnDefinition["dateTime"] = @{
                format = "dateTime"
            }
        }
        "dateOnly" {
            $columnDefinition["dateTime"] = @{
                format = "dateOnly"
            }
        }
        "boolean" {
            $columnDefinition["boolean"] = @{}
        }
        "lookup" {
            # Lookup columns require a separate API call -- see Add-SharePointLookupColumn
            throw "Use Add-SharePointLookupColumn for lookup columns"
        }
    }

    $body = $columnDefinition | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$SiteId/lists/$ListId/columns" -Method Post -Headers $Headers -Body $body
}

function Add-SharePointColumnIfNotExists {
    param(
        [string]$SiteId,
        [string]$ListId,
        [string]$Name,
        [string]$DisplayName,
        [string]$Type,
        [string[]]$Choices = @(),
        [hashtable]$Headers
    )

    if (Test-ColumnExists -SiteId $SiteId -ListId $ListId -ColumnName $Name -Headers $Headers) {
        Write-Host "    [SKIP] Column '$DisplayName' already exists" -ForegroundColor Yellow
        return @{ Skipped = $true }
    }

    Write-Host "    [CREATE] Adding column '$DisplayName' ($Type)..." -ForegroundColor Cyan
    Add-SharePointColumn -SiteId $SiteId -ListId $ListId -Name $Name -DisplayName $DisplayName -Type $Type -Choices $Choices -Headers $Headers
    Write-Host "    [OK] Column '$DisplayName' added" -ForegroundColor Green
}
```

## Add Lookup Column

Lookup columns reference another list on the same site:

```powershell
function Add-SharePointLookupColumn {
    param(
        [string]$SiteId,
        [string]$ListId,
        [string]$Name,
        [string]$DisplayName,
        [string]$LookupListId,
        [string]$LookupColumnName = "Title",
        [hashtable]$Headers
    )

    $columnDefinition = @{
        name = $Name
        displayName = $DisplayName
        lookup = @{
            listId = $LookupListId
            columnName = $LookupColumnName
            allowMultipleValues = $false
        }
    }

    $body = $columnDefinition | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$SiteId/lists/$ListId/columns" -Method Post -Headers $Headers -Body $body
}
```
