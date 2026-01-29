# AI Site Settings Reference

This document describes how to create site settings to track AI tooling usage in Power Pages sites.

## Overview

When a site is created or modified using Claude Code skills, site settings are added to track:
1. **Authoring tool** - Which tool created the site
2. **Skills used** - Which skills have been executed on the site

## Site Setting Details

### Authoring Tool Setting

| Property | Value |
|----------|-------|
| Setting Name | `Site/AI/AuthoringTool` |
| File Name | `Site-AI-AuthoringTool.sitesetting.yml` |
| Location | `.powerpages-site/site-settings/` |

| Value | Description |
|-------|-------------|
| `ClaudeCodeCLI` | Site created using Claude Code command-line interface |
| `ClaudeCodeVSCode` | Site created using Claude Code VS Code extension |

### Skill Tracking Settings

Each time a skill is used, create or update a site setting to track usage count:

| Property | Value |
|----------|-------|
| Setting Name | `Site/AI/<SkillName>` |
| File Name | `Site-AI-<SkillName>.sitesetting.yml` |
| Value | Integer count (increments each time skill is used) |

| Skill | Setting Name |
|-------|--------------|
| `/create-site` | `Site/AI/CreateSite` |
| `/add-seo` | `Site/AI/AddSeo` |
| `/add-tests` | `Site/AI/AddTests` |
| `/setup-dataverse` | `Site/AI/SetupDataverse` |
| `/add-sample-data` | `Site/AI/AddSampleData` |
| `/setup-webapi` | `Site/AI/SetupWebApi` |
| `/integrate-webapi` | `Site/AI/IntegrateWebApi` |
| `/setup-auth` | `Site/AI/SetupAuth` |

## YAML Format

### Authoring Tool

**File**: `.powerpages-site/site-settings/Site-AI-AuthoringTool.sitesetting.yml`

```yaml
description: Identifies the tool used to create this Power Pages site
id: <GENERATE_UUID>
name: Site/AI/AuthoringTool
value: ClaudeCodeCLI
```

### Skill Tracking

**File**: `.powerpages-site/site-settings/Site-AI-CreateSite.sitesetting.yml`

```yaml
description: Tracks usage count of /create-site skill on this site
id: <GENERATE_UUID>
name: Site/AI/CreateSite
value: 1
```

**Note**: The `value` is an integer that increments each time the skill is used (1, 2, 3, etc.).

## Detection Logic

The authoring tool value is determined by checking environment variables:

```powershell
$authoringTool = if ($env:TERM_PROGRAM -eq "vscode" -or $env:VSCODE_GIT_ASKPASS_NODE) {
    "ClaudeCodeVSCode"
} else {
    "ClaudeCodeCLI"
}
```

## PowerShell Helper Functions

### Create Authoring Tool Setting

```powershell
function New-AuthoringToolSetting {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ProjectRoot
    )

    $siteSettingsPath = Join-Path $ProjectRoot ".powerpages-site\site-settings"

    if (-not (Test-Path $siteSettingsPath)) {
        New-Item -ItemType Directory -Path $siteSettingsPath -Force | Out-Null
    }

    $authoringTool = if ($env:TERM_PROGRAM -eq "vscode" -or $env:VSCODE_GIT_ASKPASS_NODE) {
        "ClaudeCodeVSCode"
    } else {
        "ClaudeCodeCLI"
    }

    $uuid = [guid]::NewGuid().ToString()

    $content = @"
description: Identifies the tool used to create this Power Pages site
id: $uuid
name: Site/AI/AuthoringTool
value: $authoringTool
"@

    $fileName = "Site-AI-AuthoringTool.sitesetting.yml"
    $filePath = Join-Path $siteSettingsPath $fileName
    Set-Content -Path $filePath -Value $content -Encoding UTF8
    Write-Host "Created: $filePath (Value: $authoringTool)"
}
```

### Create/Update Skill Tracking Setting

```powershell
function New-SkillTrackingSetting {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory=$true)]
        [string]$SkillName  # e.g., "CreateSite", "AddSeo", "AddTests", "SetupDataverse", "AddSampleData", "SetupWebApi", "IntegrateWebApi", "SetupAuth"
    )

    $siteSettingsPath = Join-Path $ProjectRoot ".powerpages-site\site-settings"

    if (-not (Test-Path $siteSettingsPath)) {
        New-Item -ItemType Directory -Path $siteSettingsPath -Force | Out-Null
    }

    $fileName = "Site-AI-$SkillName.sitesetting.yml"
    $filePath = Join-Path $siteSettingsPath $fileName

    # Check if setting already exists and get current count
    $currentCount = 0
    $existingId = $null
    if (Test-Path $filePath) {
        $existingContent = Get-Content $filePath -Raw
        if ($existingContent -match 'value:\s*(\d+)') {
            $currentCount = [int]$Matches[1]
        }
        if ($existingContent -match 'id:\s*([a-f0-9-]+)') {
            $existingId = $Matches[1]
        }
    }

    $newCount = $currentCount + 1
    $uuid = if ($existingId) { $existingId } else { [guid]::NewGuid().ToString() }
    $skillSlug = $SkillName.ToLower() -replace '([a-z])([A-Z])', '$1-$2'

    $content = @"
description: Tracks usage count of /$skillSlug skill on this site
id: $uuid
name: Site/AI/$SkillName
value: $newCount
"@

    Set-Content -Path $filePath -Value $content -Encoding UTF8
    Write-Host "Updated: $filePath (count: $newCount)"
}
```

## When to Create These Settings

### Authoring Tool Setting
- **After first upload** during `/create-site` (after `.powerpages-site` folder is created)
- If it already exists, do NOT overwrite (preserve original authoring tool)

### Skill Tracking Settings
- **Every skill** should update its tracking setting before final upload
- If setting exists, increment the count; if not, create with count = 1

| Skill | When to Update | Setting Name |
|-------|----------------|--------------|
| `/create-site` | After first upload, before second upload | `Site/AI/CreateSite` |
| `/add-seo` | Before final upload | `Site/AI/AddSeo` |
| `/add-tests` | Before final upload | `Site/AI/AddTests` |
| `/setup-dataverse` | Before final upload | `Site/AI/SetupDataverse` |
| `/add-sample-data` | Before final upload | `Site/AI/AddSampleData` |
| `/setup-webapi` | Before final upload | `Site/AI/SetupWebApi` |
| `/integrate-webapi` | Before final upload | `Site/AI/IntegrateWebApi` |
| `/setup-auth` | Before final upload | `Site/AI/SetupAuth` |

## Usage Examples

### In /create-site skill

```powershell
# After first upload creates .powerpages-site folder
New-AuthoringToolSetting -ProjectRoot $projectRoot
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "CreateSite"
# Then upload again to push the settings
```

### In /add-seo skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "AddSeo"
# Then upload
```

### In /add-tests skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "AddTests"
# Then upload (if deploying tests to site)
```

### In /setup-dataverse skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupDataverse"
# Then upload
```

### In /add-sample-data skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "AddSampleData"
# Then upload
```

### In /setup-webapi skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupWebApi"
# Then upload
```

### In /integrate-webapi skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "IntegrateWebApi"
# Then upload
```

### In /setup-auth skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupAuth"
# Then upload
```
