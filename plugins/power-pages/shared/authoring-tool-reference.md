# Authoring Tool Site Setting Reference

This document describes how to create the `Site/AuthoringTool` site setting to track which tool created the Power Pages site.

## Overview

When a site is created or uploaded using Claude Code, a site setting must be added to identify the authoring tool used. This helps track site provenance and tooling analytics.

## Site Setting Details

| Property | Value |
|----------|-------|
| Setting Name | `Site/AuthoringTool` |
| File Name | `Site-AuthoringTool.sitesetting.yml` |
| Location | `.powerpages-site/site-settings/` |

### Possible Values

| Value | Description |
|-------|-------------|
| `ClaudeCodeCLI` | Site created using Claude Code command-line interface |
| `ClaudeCodeVSCode` | Site created using Claude Code VS Code extension |

## YAML Format

**File**: `.powerpages-site/site-settings/Site-AuthoringTool.sitesetting.yml`

```yaml
description: Identifies the tool used to create this Power Pages site
id: <GENERATE_UUID>
name: Site/AuthoringTool
value: ClaudeCodeCLI  # or ClaudeCodeVSCode
```

## Detection Logic

The value is determined by checking environment variables that indicate VS Code:

```powershell
$authoringTool = if ($env:TERM_PROGRAM -eq "vscode" -or $env:VSCODE_GIT_ASKPASS_NODE) {
    "ClaudeCodeVSCode"
} else {
    "ClaudeCodeCLI"
}
```

## PowerShell Helper Function

Use this function to create the authoring tool site setting:

```powershell
function New-AuthoringToolSetting {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ProjectRoot
    )

    $siteSettingsPath = Join-Path $ProjectRoot ".powerpages-site\site-settings"

    # Create directory if it doesn't exist
    if (-not (Test-Path $siteSettingsPath)) {
        New-Item -ItemType Directory -Path $siteSettingsPath -Force | Out-Null
    }

    # Detect authoring tool based on environment
    $authoringTool = if ($env:TERM_PROGRAM -eq "vscode" -or $env:VSCODE_GIT_ASKPASS_NODE) {
        "ClaudeCodeVSCode"
    } else {
        "ClaudeCodeCLI"
    }

    $uuid = [guid]::NewGuid().ToString()

    $content = @"
description: Identifies the tool used to create this Power Pages site
id: $uuid
name: Site/AuthoringTool
value: $authoringTool
"@

    $fileName = "Site-AuthoringTool.sitesetting.yml"
    $filePath = Join-Path $siteSettingsPath $fileName
    Set-Content -Path $filePath -Value $content -Encoding UTF8
    Write-Host "Created authoring tool setting: $filePath (Value: $authoringTool)"

    return @{
        FilePath = $filePath
        AuthoringTool = $authoringTool
    }
}
```

## Usage

### Inline Script (for quick use)

```powershell
$projectRoot = "<PROJECT_ROOT_PATH>"
$siteSettingsPath = Join-Path $projectRoot ".powerpages-site\site-settings"

# Create directory if it doesn't exist
if (-not (Test-Path $siteSettingsPath)) {
    New-Item -ItemType Directory -Path $siteSettingsPath -Force | Out-Null
}

# Detect authoring tool based on environment
$authoringTool = if ($env:TERM_PROGRAM -eq "vscode" -or $env:VSCODE_GIT_ASKPASS_NODE) {
    "ClaudeCodeVSCode"
} else {
    "ClaudeCodeCLI"
}

$uuid = [guid]::NewGuid().ToString()

$content = @"
description: Identifies the tool used to create this Power Pages site
id: $uuid
name: Site/AuthoringTool
value: $authoringTool
"@

$filePath = Join-Path $siteSettingsPath "Site-AuthoringTool.sitesetting.yml"
Set-Content -Path $filePath -Value $content -Encoding UTF8
Write-Host "Created authoring tool setting: $filePath (Value: $authoringTool)"
```

### Using the Helper Function

```powershell
# After defining New-AuthoringToolSetting function
New-AuthoringToolSetting -ProjectRoot "C:\repos\my-power-pages-site"
```

## When to Create This Setting

This setting should be created:

1. **Before first upload** - During `/create-site` workflow, before `pac pages upload-code-site`
2. **During site settings setup** - During `/setup-webapi` workflow, when creating the `.powerpages-site/site-settings/` folder

If the setting already exists, it should not be overwritten (the original authoring tool should be preserved).

## Checking if Setting Exists

```powershell
$settingPath = Join-Path $projectRoot ".powerpages-site\site-settings\Site-AuthoringTool.sitesetting.yml"
if (-not (Test-Path $settingPath)) {
    # Create the setting
    New-AuthoringToolSetting -ProjectRoot $projectRoot
} else {
    Write-Host "Authoring tool setting already exists, skipping creation"
}
```
