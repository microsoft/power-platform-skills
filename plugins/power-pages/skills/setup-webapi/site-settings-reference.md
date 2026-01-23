# Site Settings Reference

This document describes how to create and configure site settings for Power Pages code sites.

## Folder Structure

Site settings in Power Pages code sites are stored in the `.powerpages-site/site-settings` folder. Each setting is a separate YAML file with a unique ID.

```text
<PROJECT_ROOT>/
├── .powerpages-site/
│   ├── site-settings/
│   │   ├── Webapi-cr_product-enabled.sitesetting.yml
│   │   ├── Webapi-cr_product-fields.sitesetting.yml
│   │   ├── Webapi-cr_teammember-enabled.sitesetting.yml
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
- Example: Setting `Webapi/cr_product/enabled` → File `Webapi-cr_product-enabled.sitesetting.yml`

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

**Example** for `cr_product` table:

**File**: `.powerpages-site/site-settings/Webapi-cr_product-enabled.sitesetting.yml`
```yaml
description: Enable Web API access for the cr_product table
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: Webapi/cr_product/enabled
value: true
```

### 2. Configure Allowed Fields

**SECURITY REQUIREMENT**: Always specify explicit field names. Never use `*` as it exposes all fields including sensitive system columns. Only include fields that are needed by the frontend.

**File**: `.powerpages-site/site-settings/Webapi-<TABLE_LOGICAL_NAME>-fields.sitesetting.yml`

```yaml
description: Allowed fields for Web API access
id: <GENERATE_UUID>
name: Webapi/<TABLE_LOGICAL_NAME>/fields
value: cr_name,cr_description,cr_price,cr_imageurl,cr_isactive
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

```powershell
$projectRoot = "<PROJECT_ROOT>"  # Replace with actual path

# Configure each table with EXPLICIT field lists (never use *)
New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_product" `
    -Fields "cr_name,cr_description,cr_price,cr_category,cr_imageurl,cr_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_teammember" `
    -Fields "cr_name,cr_title,cr_email,cr_bio,cr_photourl,cr_linkedin,cr_displayorder"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_testimonial" `
    -Fields "cr_name,cr_quote,cr_company,cr_role,cr_rating,cr_photourl,cr_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_faq" `
    -Fields "cr_question,cr_answer,cr_category,cr_displayorder,cr_isactive"

New-WebApiSiteSettings -ProjectRoot $projectRoot -TableLogicalName "cr_contactsubmission" `
    -Fields "cr_name,cr_email,cr_message,cr_submissiondate,cr_status"
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
| `Webapi/<table>/fields` | Allowed fields (comma-separated) | `cr_name,cr_price` |
| `Webapi/error/innererror` | Show detailed errors (dev only) | `true` |

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
