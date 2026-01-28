# Site Settings Reference

This document describes how to create and configure site settings for Power Pages code sites.

## Folder Structure

Site settings in Power Pages code sites are stored in the `.powerpages-site/site-settings` folder. Each setting is a separate YAML file with a unique ID.

**IMPORTANT**: Use the **actual table logical names** from the `$tableMap` built in `/setup-dataverse`:
- For **reused/extended tables**: Use the existing logical name (e.g., `contoso_items`, `existing_productcategory`)
- For **new tables**: Use `{prefix}_tablename` pattern (e.g., `cr_product`)

```text
<PROJECT_ROOT>/
├── .powerpages-site/
│   ├── site-settings/
│   │   ├── Webapi-{actual_product_table}-enabled.sitesetting.yml
│   │   ├── Webapi-{actual_product_table}-fields.sitesetting.yml
│   │   ├── Webapi-{actual_teammember_table}-enabled.sitesetting.yml
│   │   └── ...
│   └── ...
```

## Site Setting File Format

Each site setting file follows this YAML format:

```yaml
description: <OPTIONAL_DESCRIPTION>
id: <UUID>
name: <SETTING_NAME>
value: <SETTING_VALUE>
```

**Important**: Field names do NOT include the `adx_` prefix (e.g., use `name` not `adx_name`).

### YAML Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | GUID | Yes | Unique identifier for this setting |
| `name` | string | Yes | Setting name (key) |
| `value` | string | Yes | Setting value |
| `description` | string | No | Optional description of the setting |

**File naming convention**: `<SETTING_NAME_WITH_DASHES>.sitesetting.yml`
- Replace `/` with `-` in the setting name
- Example: Setting `Webapi/{prefix}_product/enabled` → File `Webapi-{prefix}_product-enabled.sitesetting.yml`

### Generating Unique IDs

Each site setting must have a unique `id` field (UUID/GUID format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

**When creating YAML files directly**: Generate a valid UUID where each `x` is a hexadecimal character (0-9, a-f).

**PowerShell**:
```powershell
[guid]::NewGuid().ToString()
```

**Bash/Linux/Mac**:
```bash
uuidgen | tr '[:upper:]' '[:lower:]'
```

**Python**:
```python
import uuid
print(str(uuid.uuid4()))
```

## Required Site Settings for Each Table

For each table that needs Web API access, create these settings:

### 1. Enable Web API for Table

**File**: `.powerpages-site/site-settings/Webapi-<TABLE_LOGICAL_NAME>-enabled.sitesetting.yml`

```yaml
description: Enable Web API access for the table
id: <GENERATE_UUID>
name: Webapi/<TABLE_LOGICAL_NAME>/enabled
value: true
```

**Example** for `{prefix}_product` table:

**File**: `.powerpages-site/site-settings/Webapi-{prefix}_product-enabled.sitesetting.yml`
```yaml
description: Enable Web API access for the {prefix}_product table
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: Webapi/{prefix}_product/enabled
value: true
```

### 2. Configure Allowed Fields

**SECURITY REQUIREMENT**: Always specify explicit field names. Never use `*` as it exposes all fields including sensitive system columns. Only include fields that are needed by the frontend.

**File**: `.powerpages-site/site-settings/Webapi-<TABLE_LOGICAL_NAME>-fields.sitesetting.yml`

```yaml
description: Allowed fields for Web API access
id: <GENERATE_UUID>
name: Webapi/<TABLE_LOGICAL_NAME>/fields
value: {prefix}_name,{prefix}_description,{prefix}_price,{prefix}_imageurl,{prefix}_isactive
```

Specify comma-separated field logical names that your frontend actually needs.

### 3. Enable Error Details (Development Only)

For debugging purposes, enable detailed error messages:

**File**: `.powerpages-site/site-settings/Webapi-error-innererror.sitesetting.yml`

```yaml
description: Enable detailed error messages for debugging
id: <GENERATE_UUID>
name: Webapi/error/innererror
value: true
```

**IMPORTANT**: Disable this in production by setting value to `false` or removing the setting.

## PowerShell Helper Scripts

### Create Site Settings for a Table

```powershell
function New-WebApiSiteSettings {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory=$true)]
        [string]$TableLogicalName,
        [Parameter(Mandatory=$true)]
        [string]$Fields  # REQUIRED: Explicit field list (never use *)
    )

    # Security check: Never allow wildcard
    if ($Fields -eq "*") {
        throw "Security Error: Wildcard (*) is not allowed for fields. Specify explicit field names."
    }

    $siteSettingsPath = Join-Path $ProjectRoot ".powerpages-site\site-settings"

    # Create directory if it doesn't exist
    if (-not (Test-Path $siteSettingsPath)) {
        New-Item -ItemType Directory -Path $siteSettingsPath -Force | Out-Null
    }

    # Generate UUIDs
    $enabledUuid = [guid]::NewGuid().ToString()
    $fieldsUuid = [guid]::NewGuid().ToString()

    # Create enabled setting
    $enabledContent = @"
description: Enable Web API access for $TableLogicalName table
id: $enabledUuid
name: Webapi/$TableLogicalName/enabled
value: true
"@
    $enabledFileName = "Webapi-$TableLogicalName-enabled.sitesetting.yml"
    $enabledPath = Join-Path $siteSettingsPath $enabledFileName
    Set-Content -Path $enabledPath -Value $enabledContent -Encoding UTF8
    Write-Host "Created: $enabledPath"

    # Create fields setting
    $fieldsContent = @"
description: Allowed fields for $TableLogicalName Web API access
id: $fieldsUuid
name: Webapi/$TableLogicalName/fields
value: $Fields
"@
    $fieldsFileName = "Webapi-$TableLogicalName-fields.sitesetting.yml"
    $fieldsPath = Join-Path $siteSettingsPath $fieldsFileName
    Set-Content -Path $fieldsPath -Value $fieldsContent -Encoding UTF8
    Write-Host "Created: $fieldsPath"

    return @{
        TableName = $TableLogicalName
        EnabledFile = $enabledFileName
        FieldsFile = $fieldsFileName
    }
}
```

### Example Usage

**IMPORTANT**: Use the `$tableMap` from `/setup-dataverse` to get the actual table logical names:
- For **reused/extended tables**: Use the existing logical name from Dataverse
- For **new tables**: Use `${publisherPrefix}_tablename` pattern

```powershell
$projectRoot = "<PROJECT_ROOT>"  # Replace with actual path

# Get the publisher prefix first
$api = Initialize-DataverseApi -EnvironmentUrl $envUrl
$publisherPrefix = $api.PublisherPrefix

# The $tableMap should be retrieved from memory-bank.md or rebuilt from /setup-dataverse
# It maps table purposes to actual logical names
function Get-TableLogicalName { param([string]$Purpose) return $tableMap[$Purpose].LogicalName }

$productTable = Get-TableLogicalName "product"
$teammemberTable = Get-TableLogicalName "teammember"
$testimonialTable = Get-TableLogicalName "testimonial"
$faqTable = Get-TableLogicalName "faq"
$contactsubmissionTable = Get-TableLogicalName "contactsubmission"

# Configure each table with EXPLICIT field lists (never use *)
# NOTE: Use the actual table logical names from the mapping
New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName $productTable `
    -Fields "${publisherPrefix}_name,${publisherPrefix}_description,${publisherPrefix}_price,${publisherPrefix}_category,${publisherPrefix}_imageurl,${publisherPrefix}_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName $teammemberTable `
    -Fields "${publisherPrefix}_name,${publisherPrefix}_title,${publisherPrefix}_email,${publisherPrefix}_bio,${publisherPrefix}_photourl,${publisherPrefix}_linkedin,${publisherPrefix}_displayorder"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName $testimonialTable `
    -Fields "${publisherPrefix}_name,${publisherPrefix}_quote,${publisherPrefix}_company,${publisherPrefix}_role,${publisherPrefix}_rating,${publisherPrefix}_photourl,${publisherPrefix}_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName $faqTable `
    -Fields "${publisherPrefix}_question,${publisherPrefix}_answer,${publisherPrefix}_category,${publisherPrefix}_displayorder,${publisherPrefix}_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName $contactsubmissionTable `
    -Fields "${publisherPrefix}_name,${publisherPrefix}_email,${publisherPrefix}_message,${publisherPrefix}_submissiondate,${publisherPrefix}_status"
```

### Create Error Setting

```powershell
function New-WebApiErrorSetting {
    param(
        [string]$ProjectRoot,
        [bool]$Enabled = $true
    )

    $siteSettingsPath = Join-Path $ProjectRoot ".powerpages-site\site-settings"
    $errorUuid = [guid]::NewGuid().ToString()
    $enabledValue = if ($Enabled) { "true" } else { "false" }

    $errorContent = @"
description: Enable detailed error messages for debugging
id: $errorUuid
name: Webapi/error/innererror
value: $enabledValue
"@
    $errorFileName = "Webapi-error-innererror.sitesetting.yml"
    $errorPath = Join-Path $siteSettingsPath $errorFileName
    Set-Content -Path $errorPath -Value $errorContent -Encoding UTF8
    Write-Host "Created error setting: $errorPath"
}

# Enable detailed errors for development
New-WebApiErrorSetting -ProjectRoot $projectRoot -Enabled $true
```

## Site Settings Quick Reference

| Setting | Purpose | Example Value |
|---------|---------|---------------|
| `Webapi/<table>/enabled` | Enable Web API for table | `true` |
| `Webapi/<table>/fields` | Allowed fields (comma-separated) | `{prefix}_name,{prefix}_price` |
| `Webapi/error/innererror` | Show detailed errors (dev only) | `true` |
| `Site/AuthoringTool` | Tracks which tool created the site | `ClaudeCodeCLI` or `ClaudeCodeVSCode` |

## Authoring Tool Site Setting

When a site is created using Claude Code, a site setting must be added to track the authoring tool used.

**📖 See: [authoring-tool-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/authoring-tool-reference.md)**

This setting identifies whether the site was created using Claude Code CLI or VS Code extension.

## Validation Checklist

Before uploading:

- [ ] All YAML files have valid syntax
- [ ] Each file has a unique UUID for the `id` field
- [ ] Fields are alphabetically sorted in the YAML file
- [ ] File extensions are `.yml` (not `.yaml`)
- [ ] Field names do NOT include `adx_` prefix
- [ ] Boolean values are unquoted (`true` not `"true"`)
- [ ] Field lists use explicit names (no wildcards)
- [ ] Error setting is disabled for production
