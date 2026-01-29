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

Each time a skill is used, create a site setting to track it:

| Property | Value |
|----------|-------|
| Setting Name | `Site/AI/<SkillName>` |
| File Name | `Site-AI-<SkillName>.sitesetting.yml` |
| Value | `true` |

| Skill | Setting Name |
|-------|--------------|
| `/create-site` | `Site/AI/CreateSite` |
| `/setup-dataverse` | `Site/AI/SetupDataverse` |
| `/setup-webapi` | `Site/AI/SetupWebApi` |
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
description: Tracks that /create-site skill was used on this site
id: <GENERATE_UUID>
name: Site/AI/CreateSite
value: true
```

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

### Create Skill Tracking Setting

```powershell
function New-SkillTrackingSetting {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory=$true)]
        [string]$SkillName  # e.g., "CreateSite", "SetupDataverse", "SetupWebApi", "SetupAuth"
    )

    $siteSettingsPath = Join-Path $ProjectRoot ".powerpages-site\site-settings"

    if (-not (Test-Path $siteSettingsPath)) {
        New-Item -ItemType Directory -Path $siteSettingsPath -Force | Out-Null
    }

    $uuid = [guid]::NewGuid().ToString()

    $content = @"
description: Tracks that /$($SkillName.ToLower() -replace '([a-z])([A-Z])', '$1-$2') skill was used on this site
id: $uuid
name: Site/AI/$SkillName
value: true
"@

    $fileName = "Site-AI-$SkillName.sitesetting.yml"
    $filePath = Join-Path $siteSettingsPath $fileName
    Set-Content -Path $filePath -Value $content -Encoding UTF8
    Write-Host "Created: $filePath"
}
```

## When to Create These Settings

### Authoring Tool Setting
- **After first upload** during `/create-site` (after `.powerpages-site` folder is created)
- If it already exists, do NOT overwrite (preserve original authoring tool)

### Skill Tracking Settings
- **Every skill** should create its tracking setting before final upload
- Create even if the setting already exists (update timestamp via new upload)

| Skill | When to Create | Setting Name |
|-------|----------------|--------------|
| `/create-site` | After first upload, before second upload | `Site/AI/CreateSite` |
| `/setup-dataverse` | Before final upload | `Site/AI/SetupDataverse` |
| `/setup-webapi` | Before final upload | `Site/AI/SetupWebApi` |
| `/setup-auth` | Before final upload | `Site/AI/SetupAuth` |

## Usage Examples

### In /create-site skill

```powershell
# After first upload creates .powerpages-site folder
New-AuthoringToolSetting -ProjectRoot $projectRoot
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "CreateSite"
# Then upload again to push the settings
```

### In /setup-dataverse skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupDataverse"
# Then upload
```

### In /setup-webapi skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupWebApi"
# Then upload
```

### In /setup-auth skill

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupAuth"
# Then upload
```
