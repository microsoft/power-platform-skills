# HTML Reports Integration Guide

This document explains how to integrate the HTML report templates and generation scripts into the `migrate-sdm-to-edm` skill workflow.

## Folder Structure

```
plugins/power-pages/skills/migrate-sdm-to-edm/
├── assets/
│   ├── customization-report.html      # Template for customization report
│   ├── skill-execution-report.html    # Template for execution report
│   └── README.md                      # Template documentation
├── scripts/
│   └── generate-migration-reports.js  # Utility to generate reports from data
├── SKILL.md
└── DESIGN.md
```

## Workflow Integration

### Phase 8: Customization Report & Analysis

**Current flow (SKILL.md):**

1. Download customization report via PAC CLI
2. Parse and categorize findings
3. Generate HTML report
4. Present findings to user

**Implementation:**

```bash
# Phase 8 step 1: Download Customization Report
pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --siteCustomizationReportPath "./migration-report"

# Phase 8 step 2: Parse findings
# ... parsing logic ...

# Phase 8 step 3: Generate HTML report
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-sdm-to-edm/scripts/generate-migration-reports.js" \
  --customization-report "./migration-report/SiteCustomization.csv" \
  --site-name "<SITE_NAME>" \
  --website-id "<WEBSITE_ID>" \
  --template-name "<TEMPLATE_NAME>" \
  --output-dir "./migration-reports"

# Share with user
echo "Customization report: file://$(pwd)/migration-reports/customization-report.html"
```

### Phase 9: Automated Remediation (subset)

For automatable fixes (Data Model Extensions only), the same script is invoked with `--automate` and `--env-url`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-sdm-to-edm/scripts/generate-migration-reports.js" \
  --site-name "<SITE_NAME>" \
  --website-id "<WEBSITE_ID>" \
  --siteCustomizationReportPath "./migration-report/SiteCustomization.csv" \
  --env-url "https://org.crm.dynamics.com" \
  --automate \
  --environment-type "<ENV_TYPE>" \
  --output-dir "./migration-reports"
```

The script creates missing string attributes via Dataverse Web API and logs results into the execution report. All other customization types (Liquid, FetchXML, plugins, workflows) are flagged as manual.

### Phase 12: Execution Report & Summary

**Current flow (SKILL.md):**

1. Present validation checklist
2. Run rollback (if needed)
3. Generate execution report
4. Present final summary

**Implementation:**

```bash
# During Phases 1–11: skill collects timing and results
# Track all commands, results, and timing

# At end of Phase 12: generate execution report
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-sdm-to-edm/scripts/generate-migration-reports.js" \
  --site-name "<SITE_NAME>" \
  --website-id "<WEBSITE_ID>" \
  --portal-id "<PORTAL_ID>" \
  --template-name "<TEMPLATE_NAME>" \
  --execution-data "phase1,phase2,phase3,phase4,phase5,phase6,phase7,phase8,phase9,phase10,phase11,phase12" \
  --output-dir "./migration-reports"

# Share with user
echo "Execution report: file://$(pwd)/migration-reports/skill-execution-report.html"
```

## Data Structures

### Customization Report CSV (from PAC CLI)

The CSV contains:
- **Type of customization** — Category (Liquid, Data Model Extension, Plugin, etc.)
- **Guidance** — Microsoft link to remediation docs
- **Snippet** — Code snippet or detail
- **Location** — File path or table name

Example:
```
Liquid contains adx references,https://go.microsoft.com/fwlink/?linkid=2247170,"{% assign homeurl = website.adx_partialurl %}","web-templates/header/Header.webtemplate.source.html"
Data Model Extension,https://go.microsoft.com/fwlink/?linkid=2247170,"Table name : adx_ad   Column name : mspp_websiteid","Table name : adx_ad"
```

### Execution Data Structure (to be tracked by skill)

During skill execution, collect:

```json
{
  "siteName": "Contoso Portal",
  "websiteId": "076bf556-9ae6-ee11-a203-6045bdf0328e",
  "portalId": "07f35d71-c45a-4a05-9702-8f127559e48e",
  "templateName": "Starter layout 1",
  "startTime": "2024-04-20T10:30:00Z",
  "prerequisites": [
    {
      "name": "PAC CLI Version",
      "required": "1.31.6 or higher",
      "actual": "1.32.1",
      "status": "success"
    }
  ],
  "pacCommands": [
    {
      "step": 1,
      "description": "Verify Authentication",
      "command": "pac auth who",
      "status": "success",
      "output": "Authenticated to https://org12345.crm.dynamics.com"
    },
    {
      "step": 2,
      "description": "List Available Sites",
      "command": "pac pages list",
      "status": "success",
      "output": "Found 3 websites"
    }
  ],
  "phases": [
    {
      "number": 1,
      "title": "Verify Prerequisites",
      "status": "completed",
      "results": [
        {
          "type": "success",
          "title": "PAC CLI Verified",
          "description": "PAC CLI version 1.32.1 meets minimum requirement"
        }
      ]
    }
  ],
  "customizations": {
    "liquidReferences": 8,
    "dataModelExtensions": 15,
    "pluginsRegistered": 2,
    "customWorkflows": 1
  },
  "remediationRequired": true,
  "remediationSteps": [
    {
      "type": "Liquid References",
      "count": 8,
      "guidance": "Replace adx_* Liquid objects with powerpagecomponent equivalents"
    }
  ],
  "endTime": "2024-04-20T10:45:00Z"
}
```

## Integration Points in SKILL.md

### Phase 8: Customization Report Generation

The skill calls the script after parsing the CSV from PAC CLI:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-sdm-to-edm/scripts/generate-migration-reports.js" `
  --customization-report "<REPORT_PATH>" `
  --site-name "<SITE_NAME>" `
  --website-id "<WEBSITE_ID>" `
  --template-name "<TEMPLATE_NAME>" `
  --output-dir "<OUTPUT_DIR>"
```

Open the generated HTML report in your browser: `file://<OUTPUT_DIR>/customization-report.html`

### Phase 9: Automated Remediation

The same script runs with `--automate` to apply safe fixes via Dataverse API (Data Model Extensions only):

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-sdm-to-edm/scripts/generate-migration-reports.js" `
  --site-name "<SITE_NAME>" `
  --website-id "<WEBSITE_ID>" `
  --siteCustomizationReportPath "<REPORT_PATH>" `
  --env-url "<ENV_URL>" `
  --automate `
  --environment-type "<ENV_TYPE>" `
  --output-dir "<OUTPUT_DIR>"
```

### Phase 12: Final Execution Report

At the end of post-migration validation:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-sdm-to-edm/scripts/generate-migration-reports.js" `
  --site-name "<SITE_NAME>" `
  --website-id "<WEBSITE_ID>" `
  --portal-id "<PORTAL_ID>" `
  --template-name "<TEMPLATE_NAME>" `
  --output-dir "<OUTPUT_DIR>"
```

The execution report includes:

- All PAC commands executed and their results
- Prerequisite verification status
- Migration phase details
- Customization analysis summary
- Remediation guidance
- Post-migration validation checklist
- Next steps

Open the report in your browser: `file://<OUTPUT_DIR>/skill-execution-report.html`

## Using `browser_navigate` to Open Reports

In the Claude skill, after generating reports, use Playwright to open them in the user's browser:

```javascript
// Open customization report
await browser_navigate(`file://${path.resolve('./migration-reports/customization-report.html')}`);

// Take accessibility snapshot
const snapshot = await browser_snapshot();
console.log('Report loaded successfully');
```

Or inform the user of the file path for manual opening:

```
I've generated two detailed reports in the `migration-reports` folder:

1. **Customization Report**: Shows all customizations found
   Open: file://${pwd}/migration-reports/customization-report.html

2. **Execution Report**: Shows all migration steps and results
   Open: file://${pwd}/migration-reports/skill-execution-report.html

You can open these files in your browser to review the details.
```

## Development Notes

### Template Customization

If you need to modify the templates:

1. Edit `customization-report.html` or `skill-execution-report.html` in the `assets/` folder
2. Update the placeholder documentation in `assets/README.md`
3. Update the placeholder replacement logic in `generate-migration-reports.js`

### Adding New Customization Types

To add a new customization type badge:

1. Add the CSS class in the template (e.g., `.badge-newtype { ... }`)
2. Update the `badgeMap` in `generate-migration-reports.js`
3. Update the documentation

### CSV Parsing

The script uses a built-in CSV parser (no npm dependency) — see `parseCSV()` in `generate-migration-reports.js`. It handles quoted values, embedded quotes (`""` → `"`), and `\r\n` line endings.

### Dependencies

The script imports only:

- Node stdlib: `fs`, `path`
- The plugin-shared validation helpers at `plugins/power-pages/scripts/lib/validation-helpers.js` (provides `getAuthToken`, `makeRequest`, `getEnvironmentUrl`)

No `npm install` is required to run the script.

## Sample Output

After running the generation script:

```
✓ Customization report generated: C:\path\to\migration-reports\customization-report.html
✓ Execution report generated: C:\path\to\migration-reports\skill-execution-report.html

Reports generated successfully!
Open in browser: file:///C:/path/to/migration-reports/customization-report.html
```

Both HTML files are self-contained (no external dependencies) and can be:
- Opened directly in any modern browser
- Saved for later reference
- Included in documentation
- Shared with stakeholders
